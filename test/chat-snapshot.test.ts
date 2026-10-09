import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type {
  ConversationId,
  EntryId,
  EntryDraft,
  JsonObject,
} from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";
import { chatSnapshot, CHAT_PAGE_SIZE } from "../src/chat-snapshot.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-transport-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  const id = await app.create("Synthetic 24 MB history");
  const firstIds: EntryId[] = [];
  await app.harness.commit(async (tx) => {
    for (let n = 0; n < 1600; n++) {
      const text =
        n < 2 ? "A".repeat(4_100_000) : `Synthetic ${n}: ` + "x".repeat(10_000);
      const message =
        n === 0
          ? {
              ...fauxAssistantMessage(""),
              content: [
                {
                  type: "toolCall" as const,
                  id: "call-large",
                  name: "read_file",
                  arguments: { encoded: text },
                },
              ],
            }
          : n === 1
            ? {
                role: "toolResult" as const,
                toolCallId: "call-large",
                toolName: "read_file",
                content: [{ type: "text" as const, text }],
                isError: false,
                timestamp: 1,
              }
            : fauxAssistantMessage(text);
      const entry = await tx.appendEntry(Number(id) as ConversationId, {
        kind: "pi.assistant",
        model: [message],
      });
      if (n < 2) firstIds.push(entry.id);
    }
  }, context);
  const origin = "http://127.0.0.1:3199";
  const web = createAppServer(app, {
    password: "synthetic-test-password",
    origin,
    secureCookie: false,
  });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
  );
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password: "synthetic-test-password" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  return {
    app,
    id,
    base,
    origin,
    cookie,
    firstIds,
    get: (path: string, auth = true) =>
      fetch(base + path, { headers: auth ? { cookie } : {} }),
    async close() {
      await web.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("24 MB durable history becomes bounded chat pages; every original message and model byte survives", async (t) => {
  const f = await fixture();
  try {
    const original = await f.app.snapshot(f.id);
    const originalText = JSON.stringify(original.view.entries);
    assert.ok(Buffer.byteLength(originalText) > 24_000_000);
    const seen = new Set<string>();
    let largest = 0;
    for (let page = 0; page < 20; page++) {
      const projected = chatSnapshot(original, page);
      const bytes = Buffer.byteLength(JSON.stringify(projected));
      largest = Math.max(largest, bytes);
      assert.ok(bytes < 400_000, `page ${page}: ${bytes} bytes`);
      assert.equal(projected.history.messages.length, CHAT_PAGE_SIZE);
      assert.equal(projected.history.total, 1600);
      assert.equal(projected.history.page, page);
      for (const key of projected.history.keys) {
        assert.ok(!seen.has(key));
        seen.add(key);
      }
    }
    assert.equal(seen.size, 1600);
    assert.equal(
      JSON.stringify((await f.app.snapshot(f.id)).view.entries),
      originalText,
    );
    const conversation = await f.app.conversation(f.id);
    assert.equal((await conversation.context(context)).entries.length, 1600);
    for (const entryId of f.firstIds) {
      const exact = original.view.entries.find((entry) => entry.id === entryId)!
        .model![0];
      const response = await f.get(
        `/api/conversations/${f.id}/history/${entryId}/0`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), exact);
    }
    const legacy = await f.get(`/api/conversations/${f.id}`);
    assert.equal(await legacy.text(), JSON.stringify(original));
    const compact = await f.get(`/api/conversations/${f.id}?view=chat&page=19`);
    const newest = chatSnapshot(original, 19);
    assert.deepEqual(await compact.json(), JSON.parse(JSON.stringify(newest)));
    const other = await f.app.create("Other");
    assert.equal(
      (await f.get(`/api/conversations/${other}/history/${f.firstIds[0]}/0`))
        .status,
      404,
    );
    assert.equal(
      (
        await f.get(
          `/api/conversations/${f.id}/history/${f.firstIds[0]}/0`,
          false,
        )
      ).status,
      401,
    );
    assert.equal(
      (await f.get(`/api/conversations/${f.id}?view=chat&page=-1`)).status,
      400,
    );
    assert.equal(
      (await f.get(`/api/conversations/${f.id}?view=chat&page=NaN`)).status,
      400,
    );
    t.diagnostic(
      `Original history: ${Buffer.byteLength(originalText)} bytes; largest compact page: ${largest} bytes.`,
    );
  } finally {
    await f.close();
  }
});

test("compact SSE reconnects, live/SQLite updates and POST refresh never transfer the 24 MB history", async (t) => {
  const f = await fixture();
  const original = await f.app.snapshot(f.id);
  const originalSnapshot = f.app.snapshot.bind(f.app);
  let source = original;
  f.app.snapshot = async (_id, compact) => ({
    ...(await originalSnapshot(_id, compact)),
    view: source.view,
  });
  const streams: ReturnType<typeof httpRequest>[] = [];
  async function open() {
    const frames: string[] = [];
    let buffer = "";
    const request = httpRequest(
      `${f.base}/api/conversations/${f.id}/events?view=chat&page=0`,
      { headers: { cookie: f.cookie } },
    );
    streams.push(request);
    const response = await new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        request.once("response", resolve);
        request.once("error", reject);
        request.end();
      },
    );
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (/^event: (snapshot|state)\n/.test(frame)) frames.push(frame);
      }
    });
    async function waitFor(count: number) {
      const deadline = Date.now() + 5000;
      while (frames.length < count && Date.now() < deadline) await delay(10);
      assert.equal(frames.length, count);
    }
    return {
      frames,
      response,
      waitFor,
      close() {
        response.destroy();
        request.destroy();
      },
    };
  }
  try {
    const first = await open();
    await first.waitFor(1);
    const bytes = Buffer.byteLength(first.frames[0]);
    assert.ok(bytes < 400_000);
    await delay(1100);
    assert.equal(first.frames.length, 1, "idle projections are deduplicated");
    source = {
      ...source,
      view: {
        ...source.view,
        docs: {
          ...source.view.docs,
          "pi.live": {
            run: { taskId: 1 },
            generation: {
              message: fauxAssistantMessage(
                "live " + "Z".repeat(4_100_000),
              ) as unknown as JsonObject,
            },
          },
        },
      },
    };
    await first.waitFor(2);
    assert.ok(Buffer.byteLength(first.frames[1]) < 10_000);
    assert.ok(first.frames[1].startsWith("event: state\n"));
    assert.ok(!JSON.parse(first.frames[1].split("\ndata: ")[1]).history);
    const action = "a".repeat(24);
    f.app.store.run(
      "INSERT INTO actions(id,conversationId,server,tool,args,state,result,evidence) VALUES (?,?,?,?,?,'done',?,?)",
      action,
      f.id,
      "mock",
      "read",
      JSON.stringify({ encoded: "A".repeat(4_100_000) }),
      "R".repeat(4_100_000),
      "{}",
    );
    await first.waitFor(3);
    assert.ok(Buffer.byteLength(first.frames[2]) < 15_000);
    const actionState = JSON.parse(first.frames[2].split("\ndata: ")[1]);
    assert.ok(actionState.actions[0].args.length < 4096);
    assert.equal(actionState.actions[0].detailsAvailable, 1);
    const details = await f.get(`/api/conversations/${f.id}/actions/${action}`);
    assert.equal(
      ((await details.json()) as { result: string }).result.length,
      4_100_000,
    );
    first.close();
    const second = await open();
    await second.waitFor(1);
    assert.ok(second.frames[0].startsWith("event: snapshot\n"));
    const reconnected = JSON.parse(second.frames[0].split("\ndata: ")[1]);
    const lastState = JSON.parse(first.frames[2].split("\ndata: ")[1]);
    assert.deepEqual(
      reconnected.history.keys,
      JSON.parse(first.frames[0].split("\ndata: ")[1]).history.keys,
    );
    assert.deepEqual(reconnected.actions, lastState.actions);
    assert.deepEqual(reconnected.view, lastState.view);
    source = {
      ...source,
      view: {
        ...source.view,
        entries: [
          ...source.view.entries,
          { ...source.view.entries.at(-1)!, id: 9999 as EntryId },
        ],
      },
    };
    await second.waitFor(2);
    assert.ok(second.frames[1].startsWith("event: snapshot\n"));
    assert.equal(
      JSON.parse(second.frames[1].split("\ndata: ")[1]).history.total,
      1601,
    );
    f.app.admit = async () =>
      ({
        kind: "message",
        requestId: "synthetic",
        submissionId: 1,
        conversationId: f.id,
      }) as Awaited<ReturnType<Runtime["admit"]>>;
    const ack = await fetch(`${f.base}/api/conversations/${f.id}/messages`, {
      method: "POST",
      headers: {
        cookie: f.cookie,
        origin: f.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId: "synthetic", text: "harmless test" }),
    });
    assert.equal(ack.status, 202);
    const refresh = await f.get(`/api/conversations/${f.id}?view=chat&page=0`);
    assert.ok(Buffer.byteLength(await refresh.text()) < 420_000);
    t.diagnostic(
      `Initial SSE frame: ${bytes} bytes; live update: ${Buffer.byteLength(first.frames[1])} bytes; SQLite result update: ${Buffer.byteLength(first.frames[2])} bytes.`,
    );
    second.close();
  } finally {
    for (const request of streams) request.destroy();
    await f.close();
  }
});

test("hidden CUA feedback and unsupported blocks do not consume history pages; control state remains intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-projection-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  try {
    const id = await app.create();
    await app.harness.commit(async (tx) => {
      await tx.appendEntry(Number(id) as ConversationId, {
        kind: "app.cua-control",
        model: [
          { role: "user", content: "internal control note", timestamp: 1 },
        ],
      });
      const entry: EntryDraft = {
        kind: "pi.assistant",
        model: [fauxAssistantMessage("ordinary answer")],
      };
      await tx.appendEntry(Number(id) as ConversationId, entry);
    }, context);
    const snapshot = await app.snapshot(id);
    const projected = chatSnapshot(snapshot, 999);
    assert.equal(projected.history.page, 0);
    assert.equal(projected.history.total, 1);
    assert.deepEqual(projected.actions, snapshot.actions);
    assert.deepEqual(projected.cuaHandoffs, snapshot.cuaHandoffs);
    const hidden = snapshot.view.entries.find(
      (entry) => entry.kind === "app.cua-control",
    )!;
    await assert.rejects(
      app.historyMessage(id, Number(hidden.id), 0),
      /Mensagem não encontrada/,
    );
    assert.equal((await app.snapshot(id)).view.entries.length, 2);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
