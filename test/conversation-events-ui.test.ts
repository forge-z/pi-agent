import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const streams: FakeEvents[] = [];
  class FakeEvents {
    closed = false;
    listeners = new Map<string, () => void>();
    constructor(readonly url: string) {
      streams.push(this);
    }
    addEventListener(name: string, action: () => void) {
      this.listeners.set(name, action);
    }
    removeEventListener(name: string, action: () => void) {
      if (this.listeners.get(name) === action) this.listeners.delete(name);
    }
    close() {
      this.closed = true;
    }
    changed() {
      this.listeners.get("conversations")?.();
    }
  }
  const calls: Array<{
    gate: ReturnType<typeof deferred>;
    active: () => boolean;
  }> = [];
  const errors: unknown[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const attach = runInNewContext(
    readFileSync(
      new URL("../public/conversation-events.js", import.meta.url),
      "utf8",
    ).replace("export function", "function") + "\nattachConversationEvents",
    {
      EventSource: FakeEvents,
      setTimeout: (callback: () => void) => {
        timers.set(++timerId, callback);
        return timerId;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  ) as (callbacks: {
    refresh: (active: () => boolean) => Promise<void>;
    report: (error: unknown) => void;
  }) => { start(stream?: FakeEvents): void; stop(): void };
  const controller = attach({
    refresh: (active) => {
      const gate = deferred();
      calls.push({ gate, active });
      return gate.promise;
    },
    report: (error) => errors.push(error),
  });
  return { controller, streams, calls, errors, timers, FakeEvents };
}

test("global conversation events refresh the list independently of the selected history and coalesce a burst", async () => {
  const f = fixture();
  f.controller.start();
  const stream = f.streams[0]!;
  assert.equal(stream.url, "/api/conversations/events");
  stream.changed();
  await flush();
  assert.equal(f.calls.length, 1);
  stream.changed();
  stream.changed();
  stream.changed();
  await flush();
  assert.equal(f.calls.length, 1, "only one list refresh may run at once");
  f.calls[0]!.gate.resolve();
  await flush();
  assert.equal(
    f.calls.length,
    2,
    "one trailing refresh captures changes during the read",
  );
  f.calls[1]!.gate.resolve();
  await flush();
  assert.equal(f.calls.length, 2);
  f.controller.stop();
  assert.equal(stream.closed, true);
});

test("a failed list read retries the missed notification and logout cancels its retry", async () => {
  const f = fixture();
  f.controller.start();
  f.streams[0]!.changed();
  await flush();
  f.calls[0]!.gate.reject(new Error("synthetic transient read failure"));
  await flush();
  assert.equal(f.errors.length, 1);
  assert.equal(f.timers.size, 1);
  [...f.timers.values()][0]!();
  await flush();
  assert.equal(f.calls.length, 2);
  f.calls[1]!.gate.reject(new Error("synthetic repeated read failure"));
  await flush();
  const staleRetry = [...f.timers.values()][0]!;
  f.controller.stop();
  assert.equal(f.timers.size, 0);
  staleRetry();
  await flush();
  assert.equal(f.calls.length, 2);
});

test("list notifications reuse the selected history connection and never close a borrowed stream", async () => {
  const f = fixture();
  const first = new f.FakeEvents("/api/conversations/1/events");
  f.controller.start(first);
  assert.equal(f.streams.length, 1);
  first.changed();
  await flush();
  f.calls[0]!.gate.resolve();
  await flush();
  const next = new f.FakeEvents("/api/conversations/2/events");
  f.controller.start(next);
  assert.equal(first.listeners.size, 0);
  assert.equal(first.closed, false);
  f.controller.stop();
  assert.equal(next.listeners.size, 0);
  assert.equal(next.closed, false);
});

test("logout/restart invalidates delayed callbacks and closes the old event source", async () => {
  const f = fixture();
  f.controller.start();
  f.streams[0]!.changed();
  await flush();
  assert.equal(f.calls[0]!.active(), true);
  f.controller.stop();
  assert.equal(f.calls[0]!.active(), false);
  f.streams[0]!.changed();
  f.controller.start();
  f.streams[1]!.changed();
  await flush();
  assert.equal(f.calls.length, 2);
  f.calls[0]!.gate.resolve();
  await flush();
  assert.equal(
    f.calls.length,
    2,
    "old stream cannot queue work into a new login",
  );
  assert.equal(f.calls[1]!.active(), true);
  f.calls[1]!.gate.resolve();
  f.controller.stop();
});
