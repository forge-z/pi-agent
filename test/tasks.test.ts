import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { Store } from "../src/store.js";
import { TaskError, Tasks } from "../src/tasks.js";

const gateway = { call: async () => ({ content: [] }) };
const epoch = Date.parse("2026-10-07T12:00:00Z");
const once = {
  title: "Lembrete",
  prompt: "Resuma o contexto",
  kind: "once",
  schedule: "2026-10-07T12:00:01Z",
};
const cron = { ...once, kind: "cron", schedule: "* * * * *" };
async function temp() {
  return mkdtemp(join(tmpdir(), "pi-tasks-test-"));
}
async function fixture() {
  const dir = await temp();
  const store = new Store(dir);
  let now = epoch;
  let submits = 0;
  let fail = false;
  let creates = 0;
  const runtime = {
    store,
    create: async () => {
      const id = String(++creates);
      store.run("INSERT INTO conversations VALUES (?,?)", id, "Task");
      return id;
    },
    conversation: async (id: string) => {
      if (!store.get("SELECT id FROM conversations WHERE id=?", id))
        throw new Error("Conversa não encontrada");
      return {};
    },
    submit: async (
      conversationId: string,
      requestId: string,
      text: string,
      source: string,
      chat: string | null,
    ) => {
      submits++;
      if (fail) throw new Error("Falha de admissão");
      store.run(
        "INSERT OR IGNORE INTO requests(conversationId,requestId,text,source,chat) VALUES (?,?,?,?,?)",
        conversationId,
        requestId,
        text,
        source,
        chat,
      );
      return { requestId, conversationId, submissionId: 1 };
    },
  };
  const tasks = new Tasks(runtime as unknown as Runtime, () => now);
  return {
    store,
    tasks,
    runtime,
    get submits() {
      return submits;
    },
    get creates() {
      return creates;
    },
    set time(value: number) {
      now = value;
    },
    set fail(value: boolean) {
      fail = value;
    },
    finish(status = "done") {
      store.run("UPDATE requests SET status=?", status);
    },
    async close() {
      await tasks.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function settle(app: Runtime, conversationId: string) {
  await (await app.conversation(conversationId)).waitForIdle(context);
  for (let n = 0; n < 50; n++) {
    if (!app.store.get("SELECT requestId FROM requests WHERE status='pending'"))
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Runtime monitor did not settle the input");
}

test("creation receipts deduplicate concurrent calls and survive restart even after a once date expires", async () => {
  const f = await fixture();
  let reopened: Tasks | undefined;
  try {
    const input = { ...once, conversationId: await f.runtime.create() };
    const [a, b] = await Promise.all([
      f.tasks.create(input, "chat:create:1"),
      f.tasks.create(input, "chat:create:1"),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(f.tasks.list().length, 1);
    await f.tasks.close();
    reopened = new Tasks(f.runtime as unknown as Runtime, () => epoch + 60000);
    assert.equal((await reopened.create(input, "chat:create:1")).id, a.id);
    await assert.rejects(
      reopened.create({ ...input, prompt: "Different" }, "chat:create:1"),
      /conteúdo diferente/,
    );
    reopened.remove(a.id);
    await assert.rejects(
      reopened.create(input, "chat:create:1"),
      /não encontrada/,
    );
    assert.equal(
      reopened.list().length,
      0,
      "a replay must not resurrect a deleted schedule",
    );
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test("delivery tool receipts survive restart and cannot reapply an old destination or reuse a key", async () => {
  const f = await fixture();
  let reopened: Tasks | undefined;
  try {
    const task = await f.tasks.create(cron);
    f.store.run("UPDATE tasks SET delivery='legacy' WHERE id=?", task.id);
    const first = f.tasks.setDelivery(task.id, "web", "chat:1:delivery");
    f.store.run("UPDATE tasks SET delivery='legacy' WHERE id=?", task.id);
    await f.tasks.close();
    reopened = new Tasks(f.runtime as unknown as Runtime, () => epoch);
    assert.deepEqual(
      reopened.setDelivery(task.id, "web", "chat:1:delivery"),
      first,
    );
    assert.equal(reopened.get(task.id)?.delivery, "legacy");
    assert.throws(
      () => reopened!.setDelivery(task.id, "legacy", "chat:1:delivery"),
      /conteúdo diferente/,
    );
    assert.throws(
      () => reopened!.setDelivery(task.id, "web", "bad key"),
      /Chave/,
    );
    f.store.db.exec(
      "CREATE TRIGGER fail_delivery_receipt BEFORE INSERT ON task_delivery_changes BEGIN SELECT RAISE(ABORT,'mock disk failure'); END",
    );
    assert.throws(
      () => reopened!.setDelivery(task.id, "web", "chat:1:failure"),
      /mock disk failure/,
    );
    assert.equal(reopened.get(task.id)?.delivery, "legacy");
    assert.equal(f.store.all("SELECT * FROM task_delivery_changes").length, 1);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test("old task rows migrate to legacy delivery and new tasks default to web", async () => {
  const f = await fixture();
  let migrated: Tasks | undefined;
  try {
    await f.tasks.close();
    const conversationId = await f.runtime.create();
    f.store.db.exec("DROP TABLE tasks");
    f.store.db.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
      conversationId TEXT NOT NULL, kind TEXT NOT NULL, schedule TEXT NOT NULL,
      timezone TEXT NOT NULL, enabled INTEGER NOT NULL, nextRun INTEGER,
      lastError TEXT, deleted INTEGER NOT NULL DEFAULT 0
    )`);
    f.store.run(
      "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      "legacy-task",
      "Old reminder",
      "Read the conversation",
      conversationId,
      "cron",
      "* * * * *",
      "UTC",
      1,
      epoch + 60000,
      null,
      0,
    );
    migrated = new Tasks(f.runtime as unknown as Runtime, () => epoch);
    assert.equal(migrated.get("legacy-task")?.delivery, "legacy");
    const created = await migrated.create({
      ...cron,
      conversationId,
    });
    assert.equal(created.delivery, "web");
    assert.throws(() => migrated!.setDelivery(created.id, "legacy"), /Destino/);
    assert.equal(
      migrated.setDelivery("legacy-task", "legacy").delivery,
      "legacy",
    );
  } finally {
    await migrated?.close();
    await f.close();
  }
});

test("Telegram delivery creation and updates require the current authorized binding", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    const task = await f.tasks.create({ ...cron, conversationId });
    assert.equal(task.delivery, "web");
    assert.equal(f.tasks.telegramAvailability(conversationId), false);
    await assert.rejects(
      f.tasks.create({ ...cron, conversationId, delivery: "web_telegram" }),
      /conectado e autorizado/,
    );
    assert.throws(
      () => f.tasks.setDelivery(task.id, "web_telegram"),
      /conectado e autorizado/,
    );
    const binding = {
      enabled: true,
      bot: { id: 123456 },
      userId: "42",
      chatId: "42",
      conversationId,
    };
    f.store.run(
      "INSERT INTO telegram VALUES (?,?,?)",
      "42",
      conversationId,
      "42",
    );
    f.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "42",
      "42",
      conversationId,
    );
    f.store.run(
      "INSERT INTO meta VALUES (?,?)",
      "telegram:connection",
      JSON.stringify(binding),
    );
    assert.equal(f.tasks.telegramAvailability(conversationId), true);
    const originalNextRun = task.nextRun;
    const telegramTask = f.tasks.setDelivery(task.id, "web_telegram");
    assert.equal(telegramTask.delivery, "web_telegram");
    assert.equal(telegramTask.nextRun, originalNextRun);
    assert.equal(f.tasks.setDelivery(task.id, "web").delivery, "web");
    f.store.run("DELETE FROM telegram_grants");
    assert.equal(f.tasks.telegramAvailability(conversationId), false);
    assert.throws(
      () => f.tasks.setDelivery(task.id, "web_telegram"),
      /conectado e autorizado/,
    );
  } finally {
    await f.close();
  }
});

test("schedule and creation receipt roll back together on a receipt storage failure", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    f.store.db.exec(
      "CREATE TRIGGER receipt_failure BEFORE INSERT ON task_creations BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;",
    );
    await assert.rejects(
      f.tasks.create({ ...once, conversationId }, "chat:create:failed"),
      /receipt failure/,
    );
    assert.equal(f.tasks.list().length, 0);
    assert.equal(f.store.all("SELECT * FROM task_creations").length, 0);
    f.store.db.exec("DROP TRIGGER receipt_failure");
    const task = await f.tasks.create(
      { ...once, conversationId },
      "chat:create:failed",
    );
    assert.equal(f.tasks.list()[0].id, task.id);
  } finally {
    await f.close();
  }
});

test("once admission is atomic, concurrent ticks deduplicate and done follows request completion", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create(once);
    assert.equal(task.timezone, "America/Sao_Paulo");
    assert.equal(task.nextRun, epoch + 1000);
    f.time = epoch + 1000;
    await Promise.all(Array.from({ length: 15 }, () => f.tasks.tick()));
    assert.equal(f.submits, 1);
    assert.equal(f.tasks.runs(task.id).length, 1);
    const run = f.tasks.runs(task.id)[0];
    assert.equal(run.scheduledAt, epoch + 1000);
    assert.equal(run.state, "pending");
    assert.equal(run.requestId, `task:${run.id}`);
    assert.equal(f.tasks.get(task.id)?.enabled, false);
    assert.equal(f.tasks.get(task.id)?.nextRun, null);
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id)[0].state, "pending");
    f.finish();
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id)[0].state, "done");
    assert.equal(f.submits, 1);
  } finally {
    await f.close();
  }
});

test("cron skips downtime backlog and overlapping pending occurrences", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create(cron);
    f.time = epoch + 10 * 60000 + 30000;
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id)[0].scheduledAt, epoch + 60000);
    assert.equal(f.tasks.get(task.id)?.nextRun, epoch + 11 * 60000);
    f.time = epoch + 12 * 60000;
    await Promise.all([
      f.tasks.tick(),
      f.tasks.runNow(task.id),
      f.tasks.tick(),
    ]);
    assert.equal(f.tasks.runs(task.id).length, 1);
    assert.equal(f.submits, 1);
    f.finish();
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id).length, 2);
    assert.equal(f.tasks.get(task.id)?.nextRun, epoch + 13 * 60000);
  } finally {
    await f.close();
  }
});

test("pause/resume recomputes cron; manual execution of a paused task preserves pause", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create(cron);
    f.tasks.setEnabled(task.id, false);
    f.time = epoch + 7 * 60000;
    await f.tasks.tick();
    assert.equal(f.submits, 0);
    const run = await f.tasks.runNow(task.id);
    assert.equal(run.state, "pending");
    assert.equal(f.tasks.get(task.id)?.enabled, false);
    assert.equal(f.tasks.get(task.id)?.nextRun, null);
    f.finish();
    await f.tasks.tick();
    const resumed = f.tasks.setEnabled(task.id, true);
    assert.equal(resumed.nextRun, epoch + 8 * 60000);
    await f.tasks.tick();
    assert.equal(f.submits, 1);
    assert.throws(
      () => f.tasks.setEnabled(task.id, "yes" as unknown as boolean),
      /booleano/,
    );
  } finally {
    await f.close();
  }
});

test("cron uses IANA zones across DST and accepts named weekdays without hash syntax", async () => {
  const f = await fixture();
  try {
    f.time = Date.parse("2026-03-07T12:00:00Z");
    const task = await f.tasks.create({
      ...cron,
      schedule: "0 9 * * *",
      timezone: "America/New_York",
    });
    assert.equal(task.nextRun, Date.parse("2026-03-07T14:00:00Z"));
    f.time = task.nextRun!;
    await f.tasks.tick();
    assert.equal(
      f.tasks.get(task.id)?.nextRun,
      Date.parse("2026-03-08T13:00:00Z"),
    );
    const thu = await f.tasks.create({
      ...cron,
      schedule: "0 9 * * THU",
      timezone: "UTC",
    });
    assert.equal(thu.nextRun, Date.parse("2026-03-12T09:00:00Z"));
  } finally {
    await f.close();
  }
});

test("unknown inputs, schedule syntax, zones, limits and missing conversations are rejected before creating conversations", async () => {
  const f = await fixture();
  try {
    const invalid: unknown[] = [
      null,
      [],
      {},
      { ...once, title: " " },
      { ...once, title: "a".repeat(121) },
      { ...once, prompt: "a".repeat(32001) },
      { ...once, schedule: "a".repeat(201) },
      { ...once, schedule: "2026-10-07T13:00:00" },
      { ...once, schedule: "2026-10-07T11:00:00Z" },
      { ...once, schedule: "2027-02-30T11:00:00Z" },
      { ...once, kind: "other" },
      { ...once, timezone: "+03:00" },
      { ...once, timezone: "America/Invalid" },
      { ...once, timezone: "a".repeat(101) },
      { ...once, enabled: "false" },
      { ...cron, schedule: "0 * * * * *" },
      { ...cron, schedule: "@hourly" },
      { ...cron, schedule: "H * * * *" },
      { ...cron, schedule: "H(1-3) * * * *" },
      { ...cron, schedule: "61 * * * *" },
      { ...cron, conversationId: "missing" },
    ];
    for (const value of invalid) await assert.rejects(f.tasks.create(value));
    assert.equal(f.creates, 0);
    assert.equal(f.tasks.list().length, 0);
    const offset = await f.tasks.create({
      ...once,
      schedule: "2026-10-07T09:00:01-03:00",
    });
    assert.equal(offset.nextRun, epoch + 1000);
    for (let i = 1; i < 100; i++)
      await f.tasks.create({ ...cron, enabled: false });
    await assert.rejects(f.tasks.create(cron), /100 tarefas/);
    assert.equal(f.creates, 100);
    f.tasks.remove(offset.id);
    await f.tasks.create(cron);
    assert.equal(f.tasks.list().length, 100);
  } finally {
    await f.close();
  }
});

test("admission failures and terminal input errors stay visible, pending work survives deletion", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create(once);
    f.time = epoch + 1000;
    f.fail = true;
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id)[0].state, "failed");
    assert.match(f.tasks.runs(task.id)[0].error!, /Falha de admissão/);
    assert.match(f.tasks.get(task.id)!.lastError!, /Falha de admissão/);
    f.fail = false;
    const manual = await f.tasks.runNow(task.id);
    assert.equal(manual.state, "pending");
    f.finish("timedout");
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id)[0].state, "failed");
    assert.match(f.tasks.get(task.id)!.lastError!, /timedout/);
    await f.tasks.runNow(task.id);
    f.tasks.remove(task.id);
    assert.equal(f.tasks.get(task.id), undefined);
    assert.equal(f.tasks.list().length, 0);
    f.finish();
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id)[0].state, "done");
    assert.equal(f.tasks.runs(task.id).length, 3);
    await assert.rejects(f.tasks.runNow(task.id), /não encontrada/);
  } finally {
    await f.close();
  }
});

test("close drains admitted submissions and rejects new work", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create(once);
    const run = f.tasks.runNow(task.id);
    const close = f.tasks.close();
    assert.equal((await run).state, "pending");
    await close;
    assert.equal(f.submits, 1);
    await assert.rejects(f.tasks.tick(), /encerrando/);
    await assert.rejects(f.tasks.create(cron), /encerrando/);
    assert.throws(() => f.tasks.start(), /encerrando/);
  } finally {
    await f.close();
  }
});

test("TaskError identifies safe module errors without reclassifying external failures", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.tasks.create({ ...cron, title: "" }), TaskError);
    await assert.rejects(
      f.tasks.create({ ...cron, schedule: "invalid cron" }),
      TaskError,
    );
    await assert.rejects(f.tasks.runNow("missing"), TaskError);
    assert.throws(() => f.tasks.setEnabled("missing", true), TaskError);
    await assert.rejects(
      f.tasks.create({ ...cron, conversationId: "missing" }),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof TaskError) &&
        error.message === "Conversa não encontrada",
    );
  } finally {
    await f.close();
  }
});

test("manual client keys deduplicate after completion and when joining another pending occurrence", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create({ ...cron, enabled: false });
    const first = await f.tasks.runNow(task.id, "client-key");
    const duplicate = await f.tasks.runNow(task.id, "client-key");
    const joined = await f.tasks.runNow(task.id, "other-key");
    assert.equal(duplicate.id, first.id);
    assert.equal(joined.id, first.id);
    f.finish();
    await f.tasks.tick();
    assert.equal((await f.tasks.runNow(task.id, "client-key")).id, first.id);
    assert.equal((await f.tasks.runNow(task.id, "other-key")).id, first.id);
    assert.equal(f.submits, 1);
    assert.equal(f.tasks.runs(task.id).length, 1);
    const long = await f.tasks.runNow(task.id, "a".repeat(160));
    assert.ok(long.requestId.length <= 160);
    assert.notEqual(long.id, first.id);
    assert.equal(f.tasks.get(task.id)?.enabled, false);
    for (const key of ["", "has space", "a".repeat(161), null, 42])
      await assert.rejects(
        f.tasks.runNow(task.id, key as unknown as string),
        /requestId/,
      );
    const secondTask = await f.tasks.create({ ...cron, enabled: false });
    assert.notEqual(
      (await f.tasks.runNow(secondTask.id, "client-key")).id,
      first.id,
    );
  } finally {
    await f.close();
  }
});

test("actual Runtime keeps a task result on the web when only a legacy mapping exists without an active Telegram connection", async () => {
  const dir = await temp();
  const app = await Runtime.open({ dir, gateway });
  let now = epoch;
  const tasks = new Tasks(app, () => now);
  try {
    const task = await tasks.create(once);
    app.store.run(
      "INSERT INTO telegram VALUES (?,?,?)",
      "100",
      task.conversationId,
      "42",
    );
    now += 1000;
    await tasks.tick();
    const run = tasks.runs(task.id)[0];
    await settle(app, task.conversationId);
    await tasks.tick();
    assert.equal(tasks.runs(task.id)[0].state, "done");
    assert.deepEqual(
      {
        ...app.store.get<{
          source: string;
          chat: string | null;
          status: string;
        }>(
          "SELECT source,chat,status FROM requests WHERE requestId=?",
          run.requestId,
        ),
      },
      { source: "task", chat: null, status: "done" },
    );
    const view = (await app.snapshot(task.conversationId)).view;
    assert.equal(
      view.entries.filter((entry) => entry.kind === "pi.user").length,
      1,
    );
    assert.equal(
      view.entries.filter((entry) => entry.kind === "pi.assistant").length,
      1,
    );
    assert.equal(app.store.all("SELECT * FROM deliveries").length, 0);
  } finally {
    await tasks.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("actual Runtime recovers a deleted occurrence committed before admission, without an extra occurrence", async () => {
  const dir = await temp();
  let app = await Runtime.open({ dir, gateway });
  let now = epoch;
  let tasks = new Tasks(app, () => now);
  try {
    const task = await tasks.create(once);
    const runId = randomUUID();
    app.store.db.exec("BEGIN IMMEDIATE");
    app.store.run(
      "INSERT INTO task_runs(id,taskId,scheduledAt,requestId) VALUES (?,?,?,?)",
      runId,
      task.id,
      epoch + 1000,
      `task:${runId}`,
    );
    app.store.run(
      "UPDATE tasks SET nextRun=NULL,enabled=0 WHERE id=?",
      task.id,
    );
    app.store.db.exec("COMMIT");
    tasks.remove(task.id);
    assert.equal(app.store.all("SELECT * FROM requests").length, 0);
    await tasks.close();
    await app.close();
    app = await Runtime.open({ dir, gateway });
    tasks = new Tasks(app, () => now);
    now += 60000;
    await Promise.all([tasks.tick(), tasks.tick()]);
    await settle(app, task.conversationId);
    await tasks.tick();
    assert.equal(tasks.runs(task.id).length, 1);
    assert.equal(tasks.runs(task.id)[0].id, runId);
    assert.equal(tasks.runs(task.id)[0].state, "done");
    assert.equal(app.store.all("SELECT * FROM requests").length, 1);
    assert.equal(tasks.list().length, 0);
    assert.equal(
      (await app.snapshot(task.conversationId)).view.entries.filter(
        (entry) => entry.kind === "pi.user",
      ).length,
      1,
    );
  } finally {
    await tasks.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("actual Runtime recovery deduplicates an admitted input whose request ledger remained pending", async () => {
  const dir = await temp();
  const faux = fauxProvider();
  faux.setResponses(
    Array.from({ length: 4 }, () =>
      fauxAssistantMessage("Resposta persistida"),
    ),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  let app = await Runtime.open({ dir, gateway, models });
  let tasks = new Tasks(app, () => epoch);
  try {
    const task = await tasks.create(cron);
    const run = await tasks.runNow(task.id);
    await settle(app, task.conversationId);
    const submission = app.store.get<{ submissionId: number }>(
      "SELECT submissionId FROM requests WHERE requestId=?",
      run.requestId,
    )!;
    // Crash boundary: Pi committed the outcome, while the app's receipt was not committed.
    app.store.run(
      "UPDATE requests SET status='pending' WHERE requestId=?",
      run.requestId,
    );
    await tasks.close();
    await app.close();
    app = await Runtime.open({ dir, gateway, models });
    tasks = new Tasks(app, () => epoch);
    await tasks.tick();
    await settle(app, task.conversationId);
    await tasks.tick();
    assert.equal(tasks.runs(task.id).length, 1);
    assert.equal(tasks.runs(task.id)[0].state, "done");
    assert.equal(faux.state.callCount, 1);
    assert.equal(
      app.store.get<{ submissionId: number }>(
        "SELECT submissionId FROM requests WHERE requestId=?",
        run.requestId,
      )!.submissionId,
      submission.submissionId,
    );
    assert.equal(
      (await app.snapshot(task.conversationId)).view.entries.filter(
        (entry) => entry.kind === "pi.user",
      ).length,
      1,
    );
  } finally {
    await tasks.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "actual Runtime resumes a model-pending occurrence using the same admitted input",
  { timeout: 5000 },
  async () => {
    const dir = await temp();
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const interrupted = fauxProvider();
    interrupted.setResponses([
      async (_transcript, options) => {
        started();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        return fauxAssistantMessage("Interrupted by close");
      },
    ]);
    const models = createModels();
    models.setProvider(interrupted.provider);
    let app = await Runtime.open({ dir, gateway, models });
    let tasks = new Tasks(app, () => epoch);
    try {
      const task = await tasks.create(cron);
      const run = await tasks.runNow(task.id);
      await modelStarted;
      assert.equal(tasks.runs(task.id)[0].state, "pending");
      const admitted = app.store.get<{ submissionId: number; status: string }>(
        "SELECT submissionId,status FROM requests WHERE requestId=?",
        run.requestId,
      )!;
      assert.equal(admitted.status, "pending");
      await tasks.close();
      await app.close();
      const resumed = fauxProvider();
      resumed.setResponses([fauxAssistantMessage("Resumed once")]);
      models.setProvider(resumed.provider);
      app = await Runtime.open({ dir, gateway, models });
      tasks = new Tasks(app, () => epoch);
      await tasks.tick();
      await settle(app, task.conversationId);
      await tasks.tick();
      assert.equal(tasks.runs(task.id).length, 1);
      assert.equal(tasks.runs(task.id)[0].state, "done");
      assert.equal(resumed.state.callCount, 1);
      assert.equal(
        app.store.get<{ submissionId: number }>(
          "SELECT submissionId FROM requests WHERE requestId=?",
          run.requestId,
        )!.submissionId,
        admitted.submissionId,
      );
      assert.equal(
        (await app.snapshot(task.conversationId)).view.entries.filter(
          (entry) => entry.kind === "pi.user",
        ).length,
        1,
      );
    } finally {
      await tasks.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("scheduled prompts can propose external actions but still require explicit approval", async () => {
  const dir = await temp();
  let writes = 0;
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "task-read",
        name: "mcp_read",
        arguments: { server: "mock", tool: "read", arguments: {} },
      },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "task-propose",
        name: "propose_action",
        arguments: { server: "mock", tool: "write", arguments: {} },
      },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Confirme a ação na conversa"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    models,
    gateway: {
      call: async (_s, _t, _args, kind) => {
        if (kind === "action") writes++;
        return { content: [{ type: "text", text: "Preview" }] };
      },
    },
  });
  const tasks = new Tasks(app, () => epoch);
  try {
    const task = await tasks.create({
      ...cron,
      prompt: "Prepare uma alteração externa",
    });
    await tasks.runNow(task.id);
    await settle(app, task.conversationId);
    await tasks.tick();
    assert.equal(tasks.runs(task.id)[0].state, "done");
    assert.equal(app.store.actions(task.conversationId)[0].state, "pending");
    assert.equal(writes, 0);
    assert.equal(app.store.all("SELECT * FROM deliveries").length, 0);
  } finally {
    await tasks.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
