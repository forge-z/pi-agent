import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { Telegram } from "../src/telegram.js";

const gateway = { call: async () => ({ content: [] }) };
const web = { source: "web" as const };
const update = (update_id: number, text: string, user = 42, chat = 100) => ({
  update_id,
  message: {
    message_id: update_id,
    text,
    from: { id: user },
    chat: { id: chat, type: "private" },
  },
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-commands-"));
  const faux = fauxProvider({
    models: [
      { id: "one", reasoning: true },
      { id: "two", reasoning: false },
    ],
  });
  faux.setResponses(
    Array.from({ length: 20 }, () => fauxAssistantMessage("Resposta local")),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const open = () => Runtime.open({ dir, models, gateway, modelId: "one" });
  let app = await open();
  return {
    dir,
    faux,
    get app() {
      return app;
    },
    async restart() {
      await app.close();
      app = await open();
    },
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("commands bypass the model; validation and literal slash escaping preserve message admission", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    const help = await f.app.admit(id, "help", "/help", web);
    assert.equal(help.kind, "command");
    for (const name of [
      "agents",
      "model",
      "thinking",
      "compact",
      "tasks",
      "crons",
      "stop",
      "help",
    ])
      assert.match(help.text, new RegExp(`/${name}`));
    await assert.rejects(
      f.app.admit(id, "unknown", "/new", web),
      /Comando desconhecido/,
    );
    await assert.rejects(
      f.app.admit(id, "arguments", "/stop tudo", web),
      /Uso:/,
    );
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
    await f.app.admit(id, "literal", "//help", web);
    await (await f.app.conversation(id)).waitForIdle(context);
    assert.equal(
      f.app.store.get<{ text: string }>(
        "SELECT text FROM requests WHERE requestId='literal'",
      )?.text,
      "/help",
    );
    assert.equal(f.faux.state.callCount, 1);
    await assert.rejects(f.app.admit(id, "literal", "/help", web), /requestId/);
  } finally {
    await f.close();
  }
});

test("model and effort commands use Pi capabilities; concurrent duplicates and old retries never reapply a change", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    const results = await Promise.all([
      f.app.admit(id, "model", "/model two", web),
      f.app.admit(id, "model", "/model two", web),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(await f.app.settings.conversation(id), {
      modelId: "two",
      effort: "off",
    });
    await assert.rejects(
      f.app.admit(id, "invalid-effort", "/thinking high", web),
      /suportado/,
    );
    await f.app.admit(id, "second-model", "/model one", web);
    await f.app.admit(id, "effort", "/thinking low", web);
    await f.restart();
    await f.app.admit(id, "model", "/model two", web);
    assert.deepEqual(await f.app.settings.conversation(id), {
      modelId: "one",
      effort: "low",
    });
    await assert.rejects(
      f.app.admit(id, "model", "/model one", web),
      /requestId/,
    );
    await assert.rejects(
      f.app.admit(id, "model", "reuse as message", web),
      /requestId/,
    );
    assert.equal(f.faux.state.callCount, 0);
  } finally {
    await f.close();
  }
});

test("Telegram agents only exposes conversations granted by one-use links; command delivery and retries persist", async () => {
  const f = await fixture();
  let sends = 0;
  const transport = {
    send: async () => {
      sends++;
      throw new Error("lost response");
    },
  };
  try {
    const first = await f.app.create("Primeira");
    const second = await f.app.create("Segunda");
    const privateId = await f.app.create("Privada");
    let tg = new Telegram(f.app, transport, ["42", "43"], ["100"]);
    await tg.receive(update(1, `/link ${f.app.store.link(first)}`));
    const listed = await tg.receive(update(2, "/agents"));
    assert.match(JSON.stringify(listed), /Primeira/);
    assert.doesNotMatch(JSON.stringify(listed), /Privada|Segunda/);
    await assert.rejects(
      tg.receive(update(3, `/agents ${privateId}`)),
      /autorizada/,
    );
    await tg.receive(update(4, `/link ${f.app.store.link(second)}`));
    const switched = await Promise.all([
      tg.receive(update(5, `/agents ${first}`)),
      tg.receive(update(5, `/agents ${first}`)),
    ]);
    assert.deepEqual(switched[0], switched[1]);
    assert.equal(
      f.app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM telegram WHERE chat='100'",
      )?.conversationId,
      first,
    );
    await assert.rejects(
      tg.receive(update(5, `/agents ${first}`, 43)),
      /vinculada|utilizado/,
    );
    await assert.rejects(tg.receive(update(5, "/help")), /utilizado/);
    await tg.receive(update(6, `/agents ${second}`));
    await f.restart();
    tg = new Telegram(f.app, transport, ["42", "43"], ["100"]);
    await tg.receive(update(5, `/agents ${first}`));
    assert.equal(
      f.app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM telegram WHERE chat='100'",
      )?.conversationId,
      second,
    );
    await tg.flush();
    const delivered = sends;
    await tg.receive(update(2, "/agents"));
    await tg.flush();
    assert.equal(sends, delivered);
    assert.equal(
      f.app.store.all(
        "SELECT * FROM deliveries WHERE id='command:telegram:5:0'",
      ).length,
      1,
    );
    assert.equal(f.faux.state.callCount, 0);
  } finally {
    await f.close();
  }
});

test("compact tracks a real Durable task and keeps transcript; retry uses task receipt after restart", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    await f.app.submit(id, "message", "Guarde este contexto");
    await (await f.app.conversation(id)).waitForIdle(context);
    const before = (await f.app.snapshot(id)).view.entries.length;
    const compact = await f.app.admit(
      id,
      "compact",
      "/compact Preserve as decisões",
      web,
    );
    assert.equal(compact.kind, "command");
    assert.equal(compact.command, "compact");
    assert.ok(compact.taskId);
    const record = await f.app.harness.getTask(compact.taskId!, context);
    assert.equal(record?.kind, "pi.compaction");
    await f.app.harness.waitForTask(compact.taskId!, context);
    assert.ok((await f.app.snapshot(id)).view.entries.length >= before);
    await f.restart();
    const repeated = await f.app.admit(
      id,
      "compact",
      "/compact Preserve as decisões",
      web,
    );
    assert.equal(repeated.kind, "command");
    assert.equal(repeated.taskId, compact.taskId);
    const status = await f.app.commands.receipt(id, "compact", web);
    assert.ok(["completed", "noop"].includes(status!.status!));
  } finally {
    await f.close();
  }
});

test("empty compaction reports that there was nothing to compact, rather than claiming a summary", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    const command = await f.app.admit(id, "empty-compact", "/compact", web);
    assert.equal(command.kind, "command");
    await f.app.harness.waitForTask(command.taskId!, context);
    assert.equal(
      (await f.app.commands.receipt(id, "empty-compact", web))?.status,
      "noop",
    );
    assert.equal(f.faux.state.callCount, 0);
  } finally {
    await f.close();
  }
});

test("Telegram command errors have one durable reply; crons never expose unlinked schedules", async () => {
  const f = await fixture();
  const delivered: string[] = [];
  const transport = {
    send: async (_chat: string, text: string) => {
      delivered.push(text);
      return { ok: true };
    },
  };
  try {
    const id = await f.app.create();
    const other = await f.app.create();
    await f.app.tasks.create({
      title: "Agenda visível",
      prompt: "contexto",
      conversationId: id,
      kind: "cron",
      schedule: "0 8 * * *",
      timezone: "UTC",
    });
    await f.app.tasks.create({
      title: "Agenda privada",
      prompt: "secret fixture",
      conversationId: other,
      kind: "cron",
      schedule: "0 9 * * *",
      timezone: "UTC",
    });
    let tg = new Telegram(f.app, transport, ["42"], ["100"]);
    await tg.receive(update(1, `/link ${f.app.store.link(id)}`));
    const crons = await tg.receive(update(2, "/crons"));
    assert.match(JSON.stringify(crons), /Agenda visível/);
    assert.doesNotMatch(JSON.stringify(crons), /Agenda privada|secret fixture/);
    const error = await tg.receive(update(3, "/made-up"));
    assert.match(JSON.stringify(error), /desconhecido/);
    await f.restart();
    tg = new Telegram(f.app, transport, ["42"], ["100"]);
    assert.deepEqual(await tg.receive(update(3, "/made-up")), error);
    await tg.flush();
    await tg.receive(update(3, "/made-up"));
    await tg.flush();
    assert.equal(
      delivered.filter((text) => text.includes("desconhecido")).length,
      1,
    );
    assert.equal(f.faux.state.callCount, 0);
  } finally {
    await f.close();
  }
});

test("a raced message cannot reuse a command requestId, and scheduled slash text remains model input", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    const results = await Promise.allSettled([
      f.app.admit(id, "race", "/model two", web),
      f.app.admit(id, "race", "Different content", web),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal(
      f.app.store.get("SELECT 1 FROM requests WHERE requestId='race'"),
      undefined,
    );
    await f.app.submit(id, "schedule:literal", "/help", "task");
    await (await f.app.conversation(id)).waitForIdle(context);
    assert.equal(f.faux.state.callCount, 1);
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM command_receipts WHERE requestId='schedule:literal'",
      ),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("stop interrupts real work and queued inputs, leaves calendar rows intact, old retry cannot stop new work", async () => {
  const f = await fixture();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.faux.setResponses([
    async (_transcript, options) => {
      started();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return fauxAssistantMessage("abort", { stopReason: "aborted" });
    },
    fauxAssistantMessage("Nova execução"),
  ]);
  try {
    const id = await f.app.create();
    const scheduled = await f.app.tasks.create({
      title: "Futuro",
      prompt: "resumo",
      conversationId: id,
      kind: "cron",
      schedule: "0 8 * * *",
      timezone: "America/Sao_Paulo",
    });
    await f.app.submit(id, "running", "Mensagem lenta");
    await ready;
    await f.app.submit(id, "queued", "Mensagem na fila");
    const graph = await f.app.admit(id, "tasks", "/tasks", web);
    assert.equal(graph.kind, "command");
    assert.match(JSON.stringify(graph.data), /running/);
    await assert.rejects(
      f.app.admit(id, "busy-model", "/model two", web),
      /Aguarde/,
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM command_receipts WHERE requestId='busy-model'",
      ),
      undefined,
    );
    await f.app.admit(id, "stop", "/stop", web);
    assert.deepEqual(f.app.tasks.get(scheduled.id), scheduled);
    await f.app.submit(id, "fresh", "Nova mensagem");
    await f.app.admit(id, "stop", "/stop", web);
    await (await f.app.conversation(id)).waitForIdle(context);
    assert.equal(f.faux.state.callCount, 2);
    const idle = await f.app.admit(id, "idle-tasks", "/tasks", web);
    assert.equal(idle.kind, "command");
    assert.equal(idle.data instanceof Array, true);
  } finally {
    await f.close();
  }
});
