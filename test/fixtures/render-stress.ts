// Loopback-only stress fixture. Synthetic content, no account or tool execution.
import { cp, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime.js";
import { createAppServer } from "../../src/server.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { EntryRecord } from "@earendil-works/pi-durable";

const root = await mkdtemp(join(tmpdir(), "pi-render-stress-"));
const baseline = join(root, "public-before");
await cp(resolve("public"), baseline, { recursive: true });
for (const file of ["app.js", "markdown.js", "tools.js", "style.css"])
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      join(baseline, file),
      execFileSync("git", ["show", `83a2a47:public/${file}`]),
    ),
  );
const servers: { app: Runtime; web: ReturnType<typeof createAppServer> }[] = [];
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const { app, web } of servers) {
    await web.close();
    await app.close();
  }
  await rm(root, { recursive: true, force: true });
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
setTimeout(() => void close(), 10 * 60 * 1000).unref();
for (const [index, name] of ["antes", "depois"].entries()) {
  const app = await Runtime.open({
    dir: join(root, name),
    mode: "demo",
    gateway: {
      call: async () => {
        throw new Error("Synthetic preview cannot execute tools");
      },
    },
  });
  const id = await app.create(`Estresse sintético · ${name}`);
  const other = await app.create("Conversa sintética vazia");
  const seed = await app.snapshot(id);
  const image = JSON.stringify({
    result: {
      content: [
        {
          type: "image",
          mimeType: "image/png",
          data: "A".repeat(4 * 1024 * 1024),
        },
      ],
    },
  });
  const entries: EntryRecord[] = Array.from({ length: 1600 }, (_, n) => ({
    id: (1000 + n) as EntryRecord["id"],
    conversationId: Number(id) as EntryRecord["conversationId"],
    kind: n % 2 ? "pi.toolResult" : "pi.assistant",
    model:
      n % 2
        ? [
            {
              role: "toolResult",
              toolCallId: `synthetic-${n}`,
              toolName: "synthetic_cua_result",
              content: [
                {
                  type: "text",
                  text:
                    n === 1599
                      ? image
                      : JSON.stringify({
                          result: {
                            content: [
                              { type: "text", text: `Registro fictício ${n}` },
                            ],
                          },
                        }),
                },
              ],
              isError: false,
              timestamp: 0,
            },
          ]
        : [
            fauxAssistantMessage(
              `## Resposta fictícia ${n}\n\n${"Parágrafo **sintético** com texto legível.\n\n".repeat(20)}`,
            ),
          ],
  }));
  const started = Date.now();
  app.snapshot = async (selected) =>
    selected === id
      ? {
          ...seed,
          view: {
            ...seed.view,
            entries,
            docs: {
              ...seed.view.docs,
              "pi.live": {
                generation: {
                  message: {
                    role: "assistant",
                    content: [
                      {
                        type: "text",
                        text: `Pulso sintético ${Math.floor((Date.now() - started) / 750)}. Nenhuma geração real.`,
                      },
                    ],
                  },
                },
              },
            },
          },
          settings: await app.settings.conversation(id),
        }
      : {
          ...seed,
          view: { ...seed.view, entries: [] },
          settings: await app.settings.conversation(other),
        };
  const origin = `http://127.0.0.1:${3180 + index}`;
  const web = createAppServer(app, {
    password: "synthetic-render-password",
    origin,
    secureCookie: false,
    publicDir: index ? resolve("public") : baseline,
  });
  servers.push({ app, web });
  await new Promise<void>((resolve) =>
    web.server.listen(3180 + index, "127.0.0.1", resolve),
  );
  console.info(
    JSON.stringify({
      name,
      url: `${origin}/?c=${id}`,
      password: "synthetic-render-password",
      entries: entries.length,
      payloadBytes: Buffer.byteLength(JSON.stringify(await app.snapshot(id))),
    }),
  );
}
