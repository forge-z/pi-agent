import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const source = readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function select(id, title)");
  const code = source.slice(
    start,
    source.indexOf("let rendered = null;", start),
  );
  const lists: Array<ReturnType<typeof deferred<void>>> = [];
  const reads: Array<{
    path: string;
    gate: ReturnType<typeof deferred<unknown>>;
  }> = [];
  const renders: unknown[] = [];
  const streams: FakeEvents[] = [];
  class FakeEvents {
    closed = false;
    listeners = new Map<string, (event: { data: string }) => void>();
    constructor(readonly path: string) {
      streams.push(this);
    }
    close() {
      this.closed = true;
    }
    addEventListener(
      name: string,
      callback: (event: { data: string }) => void,
    ) {
      this.listeners.set(name, callback);
    }
    onopen?: () => void;
    onerror?: () => void;
  }
  const select = runInNewContext(
    `
    let conversationId=null, conversationSelectionVersion=0, sendRefreshVersion=0, events=null,
      pendingMessage=null, rendered=null, renderedActions="", historyNavigation=null, historyPage=0, lastSnapshot=null;
    ${code}
    select;
  `,
    {
      $: () => ({ value: "", dataset: {} }),
      sessionStorage: { getItem: () => null },
      settingsUI: { updateConversation() {} },
      conversationEvents: { start() {}, stop() {} },
      historyNodes: { clear() {} },
      updateRunStatus() {},
      text() {},
      plain() {},
      t: (value: string) => value,
      history: { replaceState() {} },
      loadConversations: () => {
        const gate = deferred<void>();
        lists.push(gate);
        return gate.promise;
      },
      api: (path: string) => {
        const gate = deferred<unknown>();
        reads.push({ path, gate });
        return gate.promise;
      },
      render: (snapshot: unknown) => renders.push(snapshot),
      EventSource: FakeEvents,
    },
  ) as (id: string, title: string) => Promise<void>;
  return { select, lists, reads, renders, streams };
}

test("overlapping A to B to A selection cannot apply an old A snapshot or open a second history stream", async () => {
  const f = fixture();
  const first = f.select("1", "A");
  f.lists[0]!.resolve();
  await flush();
  const middle = f.select("2", "B");
  const latest = f.select("1", "A again");
  f.lists[2]!.resolve();
  await flush();
  assert.equal(f.reads.length, 2);
  f.reads[1]!.gate.resolve({ latest: true });
  await latest;
  f.reads[0]!.gate.resolve({ stale: true });
  await first;
  f.lists[1]!.resolve();
  await middle;
  assert.equal(f.streams.length, 1);
  assert.equal(
    f.reads.length,
    2,
    "an already superseded selection does not fetch another history",
  );
  assert.equal(JSON.stringify(f.renders), JSON.stringify([{ latest: true }]));
});

test("queued snapshot callbacks from a closed A stream are ignored after selecting A again", async () => {
  const f = fixture();
  const first = f.select("1", "A");
  f.lists[0]!.resolve();
  await flush();
  f.reads[0]!.gate.resolve({ first: true });
  await first;
  const old = f.streams[0]!;
  const next = f.select("1", "A again");
  f.lists[1]!.resolve();
  await flush();
  f.reads[1]!.gate.resolve({ next: true });
  await next;
  assert.equal(old.closed, true);
  old.listeners.get("snapshot")!({ data: JSON.stringify({ stale: true }) });
  assert.equal(
    JSON.stringify(f.renders),
    JSON.stringify([{ first: true }, { next: true }]),
  );
});
