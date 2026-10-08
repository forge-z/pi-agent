// Local-only preview with synthetic history. No provider, MCP or Telegram call.
// Optional argument: a temporary copy of src/server.ts from the base revision.
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Runtime } from "../../src/runtime.js";
import { createAppServer } from "../../src/server.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { EntryRecord } from "@earendil-works/pi-durable";

const password = "synthetic-sse-password";
const servers: Array<{
  web: ReturnType<typeof createAppServer>;
  app: Runtime;
  dir: string;
}> = [];
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const s of servers) {
    await s.web.close();
    await s.app.close();
    await rm(s.dir, { recursive: true, force: true });
  }
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
const timeout = setTimeout(() => void close(), 15 * 60 * 1000);
timeout.unref();

async function preview(
  label: string,
  port: number,
  createServer: typeof createAppServer,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-sse-preview-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: {
      call: async () => {
        throw new Error("Preview cannot execute tools");
      },
    },
  });
  const id = await app.create(`Histórico extenso · ${label}`);
  const other = await app.create(`Outra conversa · ${label}`);
  const seed = await app.snapshot(id);
  const entries: EntryRecord[] = Array.from(
    { length: 48 },
    (_, n): EntryRecord => ({
      id: (1000 + n) as EntryRecord["id"],
      conversationId: Number(id) as EntryRecord["conversationId"],
      kind: n % 2 ? "pi.toolResult" : "pi.assistant",
      model:
        n % 2
          ? [
              {
                role: "toolResult",
                toolCallId: `mock-${n}`,
                toolName: "mock_history",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      synthetic: true,
                      result: "registro fictício; ".repeat(10000),
                    }),
                  },
                ],
                isError: false,
                timestamp: 0,
              },
            ]
          : [
              fauxAssistantMessage(
                `## Resposta sintética ${n}\n\nEste conteúdo serve somente para verificar navegação, rolagem e cliques.\n\n[Referência pública](https://github.com/forge-z/pi-agent)\n\n\`\`\`text\n${"amostra; ".repeat(2000)}\n\`\`\``,
              ),
            ],
    }),
  );
  app.snapshot = async (conversationId) =>
    conversationId === id
      ? {
          ...seed,
          view: { ...seed.view, entries },
          settings: await app.settings.conversation(id),
        }
      : {
          ...seed,
          view: { ...seed.view, entries: [] },
          settings: await app.settings.conversation(other),
        };
  const origin = `http://127.0.0.1:${port}`;
  const web = createServer(app, {
    password,
    origin,
    secureCookie: false,
    publicDir: resolve("public"),
  });
  servers.push({ web, app, dir });
  await new Promise<void>((r) => web.server.listen(port, "127.0.0.1", r));
  console.info(
    JSON.stringify({
      label,
      url: `${origin}/?c=${id}`,
      password,
      payloadBytes: Buffer.byteLength(JSON.stringify(await app.snapshot(id))),
    }),
  );
  return { label, origin, id };
}

async function measure(p: Awaited<ReturnType<typeof preview>>) {
  const login = await fetch(`${p.origin}/api/login`, {
    method: "POST",
    headers: { origin: p.origin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const abort = new AbortController();
  const stop = setTimeout(() => abort.abort(), 6200);
  let bytes = 0,
    events = 0;
  const start = Date.now();
  try {
    const response = await fetch(
      `${p.origin}/api/conversations/${p.id}/events`,
      { headers: { cookie }, signal: abort.signal },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        if (buffer.slice(0, boundary).startsWith("event: snapshot")) events++;
        buffer = buffer.slice(boundary + 2);
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    clearTimeout(stop);
  }
  console.info(
    JSON.stringify({
      measurement: p.label,
      milliseconds: Date.now() - start,
      events,
      bytes,
    }),
  );
}

const previews: Awaited<ReturnType<typeof preview>>[] = [];
if (process.argv[2]) {
  const baseline = (await import(
    pathToFileURL(resolve(process.argv[2])).href
  )) as { createAppServer: typeof createAppServer };
  previews.push(await preview("antes", 3170, baseline.createAppServer));
}
previews.push(await preview("depois", 3171, createAppServer));
await Promise.all(previews.map(measure));
