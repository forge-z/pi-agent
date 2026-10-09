// Loopback-only browser stress fixture: temporary stores, faux model, synthetic data.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../../src/runtime.js";
import { createAppServer } from "../../src/server.js";
const dir = await mkdtemp(join(tmpdir(), "pi-snapshot-preview-"));
const app = await Runtime.open({
  dir,
  mode: "demo",
  gateway: {
    call: async () => {
      throw new Error("Synthetic fixture cannot execute external tools");
    },
  },
});
const id = await app.create("Estresse sintético de transferência");
await app.harness.commit(async (tx) => {
  for (let n = 0; n < 1600; n++) {
    const content =
      n < 2
        ? "A".repeat(4_100_000)
        : `Mensagem sintética ${n}: ` + "x".repeat(10_000);
    const message =
      n === 0
        ? {
            ...fauxAssistantMessage(""),
            content: [
              {
                type: "toolCall" as const,
                id: "synthetic-call",
                name: "synthetic_read",
                arguments: { encoded: content },
              },
            ],
          }
        : n === 1
          ? {
              role: "toolResult" as const,
              toolCallId: "synthetic-call",
              toolName: "synthetic_read",
              content: [{ type: "text" as const, text: content }],
              isError: false,
              timestamp: 1,
            }
          : fauxAssistantMessage(content);
    await tx.appendEntry(Number(id) as ConversationId, {
      kind: "pi.assistant",
      model: [message],
    });
  }
}, context);
const snapshot = app.snapshot.bind(app);
const seed = await snapshot(id);
const seedIds = new Set(seed.view.entries.map((entry) => entry.id));
const started = Date.now();
app.snapshot = async (selected, compact) => {
  const value = await snapshot(selected, compact);
  return {
    ...value,
    view: {
      ...value.view,
      entries: [
        ...seed.view.entries,
        ...value.view.entries.filter((entry) => !seedIds.has(entry.id)),
      ],
      docs: {
        ...value.view.docs,
        "pi.live": {
          generation: {
            message: fauxAssistantMessage(
              `Pulso sintético ${Math.floor((Date.now() - started) / 500)}`,
            ) as unknown as JsonObject,
          },
        },
      },
    },
  };
};
const origin = "http://127.0.0.1:3267";
const web = createAppServer(app, {
  password: "synthetic-snapshot-password",
  origin,
  secureCookie: false,
  publicDir: resolve("public"),
});
await new Promise<void>((resolve) =>
  web.server.listen(3267, "127.0.0.1", resolve),
);
console.log(
  JSON.stringify({
    url: `${origin}/?c=${id}`,
    entries: 1600,
    originalBytes: Buffer.byteLength(JSON.stringify(await snapshot(id))),
  }),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await web.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
setTimeout(() => void close(), 300_000).unref();
