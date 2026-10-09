import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Snapshot = Awaited<ReturnType<Runtime["snapshot"]>>;

async function stream(url: string, cookie: string, lastEventId?: string) {
  const frames: string[] = [];
  let bytes = 0;
  let buffer = "";
  const request = httpRequest(url, {
    headers: {
      cookie,
      ...(lastEventId ? { "last-event-id": lastEventId } : {}),
    },
  });
  const response = await new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
      request.end();
    },
  );
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    buffer += chunk;
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      frames.push(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  });
  return {
    response,
    frames,
    get bytes() {
      return bytes;
    },
    snapshots() {
      return frames
        .filter((frame) => frame.startsWith("event: snapshot\n"))
        .map(
          (frame) =>
            JSON.parse(
              frame.slice("event: snapshot\ndata: ".length),
            ) as Snapshot,
        );
    },
    async waitFor(count: number) {
      const deadline = Date.now() + 4000;
      while (this.snapshots().length < count && Date.now() < deadline)
        await delay(10);
      assert.equal(this.snapshots().length, count);
    },
    close() {
      response.destroy();
      request.destroy();
    },
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-sse-test-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  const id = await app.create("SSE synthetic conversation");
  let snapshot = await app.snapshot(id);
  // Transport regression: immutable synthetic history, without account data or
  // model/tool execution. The endpoint must preserve every byte on reconnect.
  const entries = Array.from({ length: 32 }, (_, n): EntryRecord => ({
    id: (n + 1) as EntryRecord["id"],
    conversationId: Number(id) as EntryRecord["conversationId"],
    kind: "pi.assistant",
    model: [
      fauxAssistantMessage(
        `Synthetic ${n}\n${"histórico de teste ".repeat(3500)}`,
      ),
    ],
  }));
  snapshot = { ...snapshot, view: { ...snapshot.view, entries } };
  let barrier: Promise<void> | undefined;
  let reads = 0;
  app.snapshot = async () => {
    reads++;
    await barrier;
    return structuredClone(snapshot);
  };
  let detached = 0;
  let watchBarrier: Promise<void> | undefined;
  let markWatchStarted!: () => void;
  const watchStarted = new Promise<void>((resolve) => {
    markWatchStarted = resolve;
  });
  app.watch = async () => {
    markWatchStarted();
    await watchBarrier;
    return () => {
      detached++;
    };
  };
  const origin = "http://127.0.0.1:3199";
  const web = createAppServer(app, {
    password: "synthetic-sse-password",
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
    body: JSON.stringify({ password: "synthetic-sse-password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  return {
    app,
    web,
    base,
    cookie,
    id,
    get snapshot() {
      return snapshot;
    },
    get reads() {
      return reads;
    },
    blockSnapshot(value: Promise<void>) {
      barrier = value;
    },
    blockWatch(value: Promise<void>) {
      watchBarrier = value;
    },
    watchStarted,
    change(update: (next: Snapshot) => void) {
      snapshot = structuredClone(snapshot);
      update(snapshot);
    },
    get detached() {
      return detached;
    },
    open(lastEventId?: string) {
      return stream(
        `${base}/api/conversations/${id}/events`,
        cookie,
        lastEventId,
      );
    },
    async close() {
      await web.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("SSE sends one long idle snapshot, emits every changed observable state, and reconnects with the full current state", async () => {
  const f = await fixture();
  const streams: Awaited<ReturnType<typeof stream>>[] = [];
  try {
    const first = await f.open();
    streams.push(first);
    await first.waitFor(1);
    assert.equal(first.response.headers["x-accel-buffering"], "no");
    const initialBytes = first.bytes;
    await delay(2200);
    assert.equal(
      first.snapshots().length,
      1,
      "an unchanged long conversation must not be retransmitted every 500ms",
    );
    assert.equal(
      first.bytes,
      initialBytes,
      "idle polls must not enqueue the history payload",
    );
    assert.deepEqual(first.snapshots()[0], f.snapshot);

    // These changes intentionally have no Durable watcher notification: SQLite
    // action, MCP and delivery transitions still need the fallback poll.
    for (const update of [
      (s: Snapshot) => {
        s.view = {
          ...s.view,
          docs: {
            ...s.view.docs,
            "pi.live": {
              generation: {
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "streaming parcial" }],
                },
              },
            },
          },
        };
      },
      (s: Snapshot) => {
        s.actions = [
          { id: "approval", state: "pending" },
        ] as Snapshot["actions"];
      },
      (s: Snapshot) => {
        s.actions[0]!.state = "done";
      },
      (s: Snapshot) => {
        s.mcpCalls = [{ id: "call", state: "paused" }] as Snapshot["mcpCalls"];
      },
      (s: Snapshot) => {
        s.mcpInteractions = [
          { id: "interaction", state: "pending" },
        ] as Snapshot["mcpInteractions"];
      },
      (s: Snapshot) => {
        s.mcpCalls[0]!.state = "done";
        s.mcpInteractions[0]!.state = "accepted";
      },
      (s: Snapshot) => {
        s.deliveries = [
          { id: "delivery", chat: "42", state: "uncertain", result: null },
        ];
      },
      (s: Snapshot) => {
        s.view = { ...s.view, docs: { ...s.view.docs, "pi.live": {} } };
      },
    ]) {
      const nextCount = first.snapshots().length + 1;
      f.change(update);
      await first.waitFor(nextCount);
      assert.deepEqual(first.snapshots().at(-1), f.snapshot);
    }
    const count = first.snapshots().length;
    await delay(1100);
    assert.equal(
      first.snapshots().length,
      count,
      "settled state also stays quiet",
    );
    assert.ok(first.frames.includes("retry: 1500"));
    // Snapshot protocol has no replay IDs; a browser's stale Last-Event-ID must
    // still receive a full current snapshot instead of an incomplete delta.
    assert.ok(first.frames.every((frame) => !frame.startsWith("id:")));
    first.close();
    const second = await f.open("stale-id");
    streams.push(second);
    await second.waitFor(1);
    assert.deepEqual(second.snapshots()[0], f.snapshot);
    await delay(1100);
    assert.equal(second.snapshots().length, 1);
    assert.ok(f.detached >= 1, "closing a stream detaches its watcher");
  } finally {
    streams.forEach((s) => s.close());
    await f.close();
  }
});

test("an idle SSE heartbeat contains no history and an expired web session closes the stream", async () => {
  const f = await fixture();
  const s = await f.open();
  try {
    await s.waitFor(1);
    const initialBytes = s.bytes;
    await delay(15200);
    assert.equal(s.snapshots().length, 1);
    assert.ok(s.frames.includes(": ping"));
    assert.equal(s.bytes - initialBytes, Buffer.byteLength(": ping\n\n"));
    const closed = new Promise<void>((resolve) =>
      s.response.once("end", resolve),
    );
    f.app.store.run("UPDATE sessions SET expires=0");
    await Promise.race([
      closed,
      delay(2000).then(() => {
        throw new Error("expired SSE session stayed open");
      }),
    ]);
  } finally {
    s.close();
    await f.close();
  }
});

test("disconnect during the initial snapshot detaches the watcher and stops polling", async () => {
  const f = await fixture();
  let release!: () => void;
  f.blockSnapshot(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const s = await f.open();
  try {
    assert.equal(f.reads, 1);
    s.close();
    await delay(100);
    assert.equal(f.detached, 1);
    release();
    await delay(1100);
    assert.equal(
      f.reads,
      1,
      "closed stream cannot keep polling or send its delayed initial snapshot",
    );
    assert.equal(s.snapshots().length, 0);
  } finally {
    release();
    s.close();
    await f.close();
  }
});

test("disconnect while the watcher attaches detaches its late subscription without starting snapshot polls", async () => {
  const f = await fixture();
  let release!: () => void;
  f.blockWatch(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const closed = new Promise<void>((resolve) => {
    f.web.server.on("request", (request, response) => {
      if (request.url?.endsWith("/events")) response.once("close", resolve);
    });
  });
  const s = await f.open();
  try {
    await f.watchStarted;
    assert.equal(f.reads, 0);
    s.close();
    await Promise.race([
      closed,
      delay(2000).then(() => {
        throw new Error("server did not observe the SSE disconnect");
      }),
    ]);
    assert.equal(
      f.detached,
      0,
      "the delayed subscription is not available yet",
    );
    release();
    await delay(1100);
    assert.equal(
      f.detached,
      1,
      "the late subscription is detached exactly once",
    );
    assert.equal(
      f.reads,
      0,
      "a disconnected stream cannot start snapshot polls",
    );
    assert.equal(s.snapshots().length, 0);
    s.close();
    await delay(10);
    assert.equal(f.detached, 1, "repeated close keeps cleanup idempotent");
  } finally {
    release();
    s.close();
    await f.close();
  }
});

test("a slow SSE reader bounds queued snapshots and receives the latest state after drain", async () => {
  const f = await fixture();
  f.change((s) => {
    s.view = {
      ...s.view,
      entries: Array.from({ length: 4 }, () => s.view.entries).flat(),
    };
  });
  let response: import("node:http").ServerResponse | undefined;
  f.web.server.on("request", (request, res) => {
    if (request.url?.endsWith("/events")) response = res;
  });
  const s = await f.open();
  s.response.pause();
  try {
    const deadline = Date.now() + 2000;
    while (!response?.writableNeedDrain && Date.now() < deadline)
      await delay(10);
    assert.ok(
      response?.writableNeedDrain,
      "synthetic long snapshot must reach real socket backpressure",
    );
    f.change((snapshot) => {
      snapshot.view = {
        ...snapshot.view,
        docs: {
          ...snapshot.view.docs,
          "pi.live": { state: "latest terminal state" },
        },
      };
    });
    const reads = f.reads;
    const queued = response.writableLength;
    await delay(1100);
    assert.equal(
      f.reads,
      reads,
      "backpressure skips serializing another history",
    );
    assert.ok(
      response.writableLength <= queued,
      "polls and heartbeat cannot grow the blocked queue",
    );
    s.response.resume();
    await s.waitFor(2);
    assert.deepEqual(s.snapshots().at(-1), f.snapshot);
  } finally {
    s.close();
    await f.close();
  }
});
