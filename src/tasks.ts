import { createHash, randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { Runtime } from "./runtime.js";
import {
  queueTaskTelegram,
  taskTelegramAvailable,
} from "./task-telegram.js";

export type TaskDelivery = "legacy" | "web" | "web_telegram";

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  conversationId: string;
  kind: "once" | "cron";
  schedule: string;
  timezone: string;
  delivery: TaskDelivery;
  enabled: boolean;
  nextRun: number | null;
  lastError: string | null;
}
export interface TaskRun {
  id: string;
  scheduledAt: number;
  state: "pending" | "done" | "failed";
  requestId: string;
  error: string | null;
}
type TaskRow = Omit<Task, "enabled"> & { enabled: number; deleted: number };
type PendingRun = TaskRun & {
  taskId: string;
  conversationId: string;
  prompt: string;
};
type TaskRuntime = Pick<
  Runtime,
  "store" | "create" | "conversation" | "submit"
>;

function text(value: unknown, field: string, limit: number) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new TaskError(`${field} inválido (máximo ${limit} caracteres)`);
  return value;
}
function nextCron(schedule: string, timezone: string, now: number) {
  if (schedule.split(/\s+/).length !== 5 || /\bH\b/i.test(schedule))
    throw new TaskError("Cron deve ter exatamente 5 campos, sem H/hash");
  try {
    return CronExpressionParser.parse(schedule, {
      tz: timezone,
      currentDate: now,
    })
      .next()
      .getTime();
  } catch {
    throw new TaskError("Expressão cron inválida");
  }
}
function onceDate(schedule: string, now: number) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      schedule,
    );
  const timestamp = Date.parse(schedule);
  if (!match || !Number.isFinite(timestamp) || timestamp <= now)
    throw new TaskError(
      "Data única deve ser ISO com Z/offset e estar no futuro",
    );
  const [, year, month, day, hour, minute, second, offset] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > days ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second ?? 0) > 59 ||
    (offset !== "Z" &&
      (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))
  )
    throw new TaskError("Data única inválida");
  return timestamp;
}
function publicTask(row: TaskRow): Task {
  const { deleted: _deleted, ...task } = row;
  void _deleted;
  return { ...task, enabled: Boolean(row.enabled) };
}

/** Calendar admission only. Pi's Harness owns model execution and durable input replay.
 * See pi-durable/dist/harness/scheduler.js and TaskRuntime.sleep in dist/types.d.ts.
 * No OS cron, shell invocation, or independent model executor is used here.
 */
export class Tasks {
  private tail: Promise<unknown> = Promise.resolve();
  private admitted = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private closing = false;
  private ticking?: Promise<void>;
  constructor(
    private runtime: TaskRuntime,
    private clock = () => Date.now(),
  ) {
    runtime.store.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
        conversationId TEXT NOT NULL, kind TEXT NOT NULL, schedule TEXT NOT NULL,
        timezone TEXT NOT NULL, delivery TEXT NOT NULL DEFAULT 'legacy',
        enabled INTEGER NOT NULL, nextRun INTEGER,
        lastError TEXT, deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL, scheduledAt INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', requestId TEXT NOT NULL UNIQUE, error TEXT,
        scheduled INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS task_pending ON task_runs(taskId) WHERE state='pending';
      CREATE TABLE IF NOT EXISTS task_run_keys(requestId TEXT PRIMARY KEY, runId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_creations(creationKey TEXT PRIMARY KEY, taskId TEXT NOT NULL, input TEXT NOT NULL);
    `);
    if (
      !runtime.store
        .all<{ name: string }>("PRAGMA table_info(tasks)")
        .some((column) => column.name === "delivery")
    )
      runtime.store.db.exec(
        "ALTER TABLE tasks ADD COLUMN delivery TEXT NOT NULL DEFAULT 'legacy'",
      );
  }
  list(): Task[] {
    return this.runtime.store
      .all<TaskRow>("SELECT * FROM tasks WHERE deleted=0 ORDER BY rowid")
      .map(publicTask);
  }
  get(id: string): Task | undefined {
    const row = this.runtime.store.get<TaskRow>(
      "SELECT * FROM tasks WHERE id=? AND deleted=0",
      id,
    );
    return row ? publicTask(row) : undefined;
  }
  private require(id: string) {
    const task = this.get(id);
    if (!task) throw new TaskError("Tarefa não encontrada");
    return task;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new TaskError("Agendador encerrando"));
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  create(input: unknown, creationKey?: string): Promise<Task> {
    return this.serialize(async () => {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new TaskError("Tarefa inválida");
      const data = input as Record<string, unknown>;
      const title = text(data.title, "Título", 120).trim();
      const prompt = text(data.prompt, "Prompt", 32000);
      const schedule = text(data.schedule, "Agenda", 200).trim();
      const delivery = this.newDelivery(data.delivery ?? "web");
      const timezone = text(
        data.timezone === undefined ? "America/Sao_Paulo" : data.timezone,
        "Fuso",
        100,
      );
      try {
        // Intl also accepts fixed offsets; require an IANA name (UTC is valid).
        if (/^[+-]/.test(timezone)) throw new TaskError("Fuso IANA inválido");
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
      } catch {
        throw new TaskError("Fuso IANA inválido");
      }
      if (data.kind !== "once" && data.kind !== "cron")
        throw new TaskError("Tipo de tarefa inválido");
      if (data.enabled !== undefined && typeof data.enabled !== "boolean")
        throw new TaskError("enabled deve ser booleano");
      // The receipt and schedule commit together, before a replay-safe tool returns.
      // Resolve a receipt before checking the current time or quota: a once schedule
      // may already be in the past when its interrupted tool is resumed.
      const signatureInput: Record<string, unknown> = {
        title,
        prompt,
        kind: data.kind,
        schedule,
        timezone,
        enabled: data.enabled !== false,
        conversationId: data.conversationId ?? null,
      };
      // Keep the prior signature for interrupted tool replays that omit the
      // newly optional field.
      if (data.delivery !== undefined) signatureInput.delivery = delivery;
      const signature = JSON.stringify(signatureInput);
      if (creationKey !== undefined) {
        if (!/^[\w:.-]{1,160}$/.test(creationKey))
          throw new TaskError("Chave de criação inválida");
        const receipt = this.runtime.store.get<{
          taskId: string;
          input: string;
        }>(
          "SELECT taskId,input FROM task_creations WHERE creationKey=?",
          creationKey,
        );
        if (receipt) {
          if (receipt.input !== signature)
            throw new TaskError(
              "Chave de criação já utilizada com conteúdo diferente",
            );
          return this.require(receipt.taskId);
        }
      }
      const nextRun =
        data.kind === "once"
          ? onceDate(schedule, this.clock())
          : nextCron(schedule, timezone, this.clock());
      if (this.list().length >= 100)
        throw new TaskError("Limite de 100 tarefas atingido");
      let conversationId: string;
      if (data.conversationId !== undefined) {
        conversationId = text(data.conversationId, "Conversa", 100);
        await this.runtime.conversation(conversationId);
      } else {
        if (delivery === "web_telegram")
          throw new TaskError(
            "Telegram não está conectado e autorizado para esta conversa. Escolha uma conversa vinculada ao bot.",
          );
        conversationId = await this.runtime.create(title);
      }
      if (
        delivery === "web_telegram" &&
        !taskTelegramAvailable(this.runtime.store, conversationId)
      )
        throw new TaskError(
          "Telegram não está conectado e autorizado para esta conversa. Conecte o bot e vincule a conversa escolhida.",
        );
      const id = randomUUID();
      this.runtime.store.db.exec("BEGIN IMMEDIATE");
      try {
        this.runtime.store.run(
          "INSERT INTO tasks(id,title,prompt,conversationId,kind,schedule,timezone,delivery,enabled,nextRun) VALUES (?,?,?,?,?,?,?,?,?,?)",
          id,
          title,
          prompt,
          conversationId,
          data.kind,
          schedule,
          timezone,
          delivery,
          data.enabled === false ? 0 : 1,
          data.enabled === false ? null : nextRun,
        );
        if (creationKey !== undefined)
          this.runtime.store.run(
            "INSERT INTO task_creations VALUES (?,?,?)",
            creationKey,
            id,
            signature,
          );
        this.runtime.store.db.exec("COMMIT");
      } catch (error) {
        this.runtime.store.db.exec("ROLLBACK");
        throw error;
      }
      return this.require(id);
    });
  }
  setEnabled(id: string, enabled: boolean): Task {
    return this.update(id, { enabled });
  }
  setDelivery(id: string, delivery: unknown): Task {
    return this.update(id, { delivery });
  }
  telegramAvailability(conversationId: string) {
    return taskTelegramAvailable(this.runtime.store, conversationId);
  }
  update(id: string, input: unknown): Task {
    if (this.closing) throw new TaskError("Agendador encerrando");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new TaskError("Atualização de tarefa inválida");
    const data = input as Record<string, unknown>;
    if (data.enabled === undefined && data.delivery === undefined)
      throw new TaskError("Informe uma alteração da tarefa");
    if (Object.keys(data).some((key) => !["enabled", "delivery"].includes(key)))
      throw new TaskError("Campo de atualização inválido");
    const task = this.require(id);
    const enabled = data.enabled ?? task.enabled;
    if (typeof enabled !== "boolean")
      throw new TaskError("enabled deve ser booleano");
    const delivery =
      data.delivery === undefined
        ? task.delivery
        : this.newDelivery(data.delivery, true);
    if (
      data.delivery !== undefined &&
      delivery === "web_telegram" &&
      !taskTelegramAvailable(this.runtime.store, task.conversationId)
    )
      throw new TaskError(
        "Telegram não está conectado e autorizado para esta conversa. Conecte o bot e vincule a conversa escolhida.",
      );
    if (task.enabled === enabled && task.delivery === delivery) return task;
    let nextRun = task.nextRun;
    if (enabled !== task.enabled) {
      nextRun = null;
      if (enabled) {
        if (task.kind === "once") {
          const consumed = this.runtime.store.get(
            "SELECT id FROM task_runs WHERE taskId=? AND scheduled=1",
            id,
          );
          if (consumed) throw new TaskError("Tarefa única já executada");
          nextRun = Date.parse(task.schedule);
        } else nextRun = nextCron(task.schedule, task.timezone, this.clock());
      }
    }
    this.runtime.store.run(
      "UPDATE tasks SET enabled=?,nextRun=?,delivery=? WHERE id=?",
      enabled ? 1 : 0,
      nextRun,
      delivery,
      id,
    );
    return this.require(id);
  }
  private newDelivery(value: unknown, allowLegacy = false): TaskDelivery {
    if (
      value === "web" ||
      value === "web_telegram" ||
      (allowLegacy && value === "legacy")
    )
      return value;
    throw new TaskError("Destino deve ser web ou web_telegram");
  }
  remove(id: string) {
    if (this.closing) throw new TaskError("Agendador encerrando");
    this.require(id);
    // Preserve admitted occurrences and their conversations, even across a restart.
    this.runtime.store.run(
      "UPDATE tasks SET deleted=1,enabled=0,nextRun=NULL WHERE id=?",
      id,
    );
  }
  runs(id: string): TaskRun[] {
    return this.runtime.store.all<TaskRun>(
      "SELECT id,scheduledAt,state,requestId,error FROM task_runs WHERE taskId=? ORDER BY rowid DESC",
      id,
    );
  }
  runNow(id: string, requestId?: string): Promise<TaskRun> {
    return this.serialize(async () => {
      this.require(id);
      if (
        requestId !== undefined &&
        (typeof requestId !== "string" || !/^[\w:.-]{1,160}$/.test(requestId))
      )
        throw new TaskError("requestId de execução inválido");
      // Bound the final Pi input key to 160 characters even for long client keys.
      const manualRequestId =
        requestId === undefined
          ? undefined
          : `task-manual:${id}:${createHash("sha256").update(requestId).digest("hex")}`;
      this.refresh();
      const run = this.claim(id, this.clock(), false, manualRequestId)!;
      await this.dispatch();
      return this.runtime.store.get<TaskRun>(
        "SELECT id,scheduledAt,state,requestId,error FROM task_runs WHERE id=?",
        run.id,
      )!;
    });
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.serialize(async () => {
      this.refresh();
      const now = this.clock();
      for (const task of this.runtime.store.all<TaskRow>(
        "SELECT * FROM tasks WHERE deleted=0 AND enabled=1 AND nextRun<=? ORDER BY nextRun",
        now,
      ))
        this.claim(task.id, now, true);
      await this.dispatch();
      this.refresh();
    }).finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  private claim(
    id: string,
    now: number,
    scheduled: boolean,
    manualRequestId?: string,
  ): TaskRun | undefined {
    const store = this.runtime.store;
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const task = store.get<TaskRow>(
        "SELECT * FROM tasks WHERE id=? AND deleted=0",
        id,
      );
      const pending = store.get<TaskRun>(
        "SELECT * FROM task_runs WHERE taskId=? AND state='pending'",
        id,
      );
      const existing = manualRequestId
        ? store.get<TaskRun>(
            "SELECT r.* FROM task_runs r JOIN task_run_keys k ON k.runId=r.id WHERE k.requestId=?",
            manualRequestId,
          )
        : undefined;
      if (existing) {
        store.db.exec("COMMIT");
        return existing;
      }
      if (
        !task ||
        (scheduled &&
          (!task.enabled || task.nextRun === null || task.nextRun > now))
      ) {
        store.db.exec("COMMIT");
        return undefined;
      }
      if (pending) {
        // Remember a retried manual request even when it joins an already pending occurrence.
        if (manualRequestId)
          store.run(
            "INSERT INTO task_run_keys VALUES (?,?)",
            manualRequestId,
            pending.id,
          );
        store.db.exec("COMMIT");
        return pending;
      }
      const run: TaskRun = {
        id: randomUUID(),
        scheduledAt: scheduled ? task.nextRun! : now,
        state: "pending",
        requestId: "",
        error: null,
      };
      run.requestId = manualRequestId ?? `task:${run.id}`;
      store.run(
        "INSERT INTO task_runs(id,taskId,scheduledAt,requestId,scheduled) VALUES (?,?,?,?,?)",
        run.id,
        id,
        run.scheduledAt,
        run.requestId,
        scheduled ? 1 : 0,
      );
      if (manualRequestId)
        store.run(
          "INSERT INTO task_run_keys VALUES (?,?)",
          manualRequestId,
          run.id,
        );
      if (scheduled) {
        // After downtime execute ONE overdue occurrence; skip the backlog by advancing from now.
        const nextRun =
          task.kind === "cron"
            ? nextCron(task.schedule, task.timezone, now)
            : null;
        store.run(
          "UPDATE tasks SET nextRun=?,enabled=?,lastError=NULL WHERE id=?",
          nextRun,
          task.kind === "cron" ? 1 : 0,
          id,
        );
      }
      store.db.exec("COMMIT");
      return run;
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  }
  private refresh() {
    const store = this.runtime.store;
    for (const run of store.all<PendingRun>(
      "SELECT r.*,t.conversationId,t.prompt FROM task_runs r JOIN tasks t ON t.id=r.taskId WHERE r.state='pending'",
    )) {
      const request = store.get<{ status: string }>(
        "SELECT status FROM requests WHERE conversationId=? AND requestId=?",
        run.conversationId,
        run.requestId,
      );
      if (!request || request.status === "pending") continue;
      const error =
        request.status === "done"
          ? null
          : `Solicitação terminou com status: ${request.status}`;
      store.run(
        "UPDATE task_runs SET state=?,error=? WHERE id=?",
        error ? "failed" : "done",
        error,
        run.id,
      );
      store.run("UPDATE tasks SET lastError=? WHERE id=?", error, run.taskId);
      this.admitted.delete(run.id);
    }
  }
  private async dispatch() {
    const store = this.runtime.store;
    for (const run of store.all<PendingRun>(
      "SELECT r.*,t.conversationId,t.prompt FROM task_runs r JOIN tasks t ON t.id=r.taskId WHERE r.state='pending' ORDER BY r.rowid",
    )) {
      if (this.admitted.has(run.id)) continue;
      try {
        // Replayed after a crash with the SAME requestId; Runtime/Pi deduplicate admission.
        await this.runtime.submit(
          run.conversationId,
          run.requestId,
          run.prompt,
          "task",
          null,
        );
        this.admitted.add(run.id);
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        store.run("UPDATE tasks SET lastError=? WHERE id=?", error, run.taskId);
        const request = store.get(
          "SELECT requestId FROM requests WHERE conversationId=? AND requestId=?",
          run.conversationId,
          run.requestId,
        );
        // A committed input may still execute. Preserve it for idempotent recovery.
        if (!request) {
          store.db.exec("SAVEPOINT task_admission_failure");
          try {
            queueTaskTelegram(
              store,
              run.conversationId,
              run.requestId,
              "A tarefa não pôde iniciar. Confira sua conexão e o estado da tarefa na web.",
            );
            store.run(
              "UPDATE task_runs SET state='failed',error=? WHERE id=?",
              error,
              run.id,
            );
            store.db.exec("RELEASE SAVEPOINT task_admission_failure");
          } catch (error) {
            store.db.exec("ROLLBACK TO SAVEPOINT task_admission_failure");
            store.db.exec("RELEASE SAVEPOINT task_admission_failure");
            throw error;
          }
        }
      }
    }
  }
  start() {
    if (this.closing) throw new TaskError("Agendador encerrando");
    if (this.timer) return;
    const tick = () => {
      void this.tick().catch(() => {});
    };
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
    tick();
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.tail;
    this.refresh();
  }
}
