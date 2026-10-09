import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { TaskId, CompactionResult } from "@earendil-works/pi-durable";
import type { Runtime } from "./runtime.js";
import { SettingsError } from "./settings.js";

export type CommandAccess =
  { source: "web" } | { source: "telegram"; user: string; chat: string };
export class CommandError extends Error {}
export const commandCatalog = [
  {
    name: "chats",
    usage: "/chats [new TÍTULO|ID]",
    description: "Listar, criar ou selecionar conversas exclusivas do Telegram",
  },
  {
    name: "agents",
    usage: "/agents [id]",
    description: "Listar ou selecionar conversas existentes",
  },
  {
    name: "model",
    usage: "/model [id]",
    description: "Consultar ou mudar o modelo da conversa",
  },
  {
    name: "thinking",
    usage: "/thinking [esforço]",
    description: "Consultar ou mudar o esforço de raciocínio",
  },
  {
    name: "compact",
    usage: "/compact [instruções]",
    description: "Compactar o contexto preservando o histórico",
  },
  {
    name: "tasks",
    usage: "/tasks",
    description: "Acompanhar execuções ativas do Pi",
  },
  { name: "crons", usage: "/crons", description: "Consultar agendamentos" },
  {
    name: "stop",
    usage: "/stop",
    description: "Interromper a execução e a fila atuais",
  },
  {
    name: "help",
    usage: "/help",
    description: "Consultar os comandos disponíveis",
  },
] as const;
export const webCommandCatalog = commandCatalog.filter(
  (entry) => entry.name !== "chats",
);
export interface CommandResult {
  kind: "command";
  command: string;
  conversationId: string;
  text: string;
  data?: unknown;
  status?: string;
  taskId?: TaskId<CompactionResult>;
}
type Receipt = {
  key: string;
  conversationId: string;
  requestId: string;
  text: string;
  state: string;
  result: string | null;
};

export function parseCommand(text: string) {
  const value = text.trim();
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(value);
  const definition = commandCatalog.find((entry) => entry.name === match?.[1]);
  if (!definition)
    throw new CommandError(
      "Comando desconhecido. Use /help ou // para enviar uma barra literal.",
    );
  const argument = match?.[2]?.trim() ?? "";
  if (
    (["tasks", "crons", "stop", "help"].includes(definition.name) &&
      argument) ||
    (["agents", "model", "thinking"].includes(definition.name) &&
      /\s/.test(argument))
  )
    throw new CommandError(`Uso: ${definition.usage}`);
  return { name: definition.name, argument };
}

/** Transport commands around the public Durable API; no Coding Agent registry is inherited. */
export class Commands {
  private work = new Map<string, Promise<CommandResult>>();
  private inputs = new Map<string, { id: string; text: string }>();
  private tails = new Map<string, Promise<unknown>>();
  constructor(private app: Runtime) {}
  key(id: string, requestId: string, access: CommandAccess) {
    return access.source === "web"
      ? `web:${id}:${requestId}`
      : `telegram:${access.chat}:${access.user}:${requestId}`;
  }
  allowed(access: CommandAccess) {
    const rows = this.app.store.all<{ id: string; title: string }>(
      access.source === "web"
        ? "SELECT id,title FROM conversations WHERE id NOT IN (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL) ORDER BY rowid DESC"
        : "SELECT c.id,c.title FROM conversations c JOIN telegram_grants g ON g.conversationId=c.id WHERE g.chat=? AND g.user=? AND c.id NOT IN (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL) ORDER BY c.rowid DESC",
      ...(access.source === "web" ? [] : [access.chat, access.user]),
    );
    return rows.filter((row) => {
      // Authenticated web access can continue any active conversation. Origin
      // metadata scopes Telegram authorization, not the web operator's access.
      if (access.source === "web") return true;
      if (!this.app.telegramChats.dedicated(row.id)) return true;
      if (!this.app.telegramChats.owns(row.id, access)) return false;
      try {
        this.app.telegramChats.binding(access);
        return true;
      } catch {
        return false;
      }
    });
  }
  authorize(id: string, access: CommandAccess) {
    if (
      access.source === "telegram" &&
      this.app.telegramChats.dedicated(id) &&
      this.app.telegramChats.owns(id, access)
    )
      // A listing may omit temporarily unavailable rows. An admission must
      // preserve the actual error so polling can retry rather than reject it.
      this.app.telegramChats.binding(access);
    if (!this.allowed(access).some((item) => item.id === id))
      throw new CommandError(
        "Conversa não autorizada. Vincule-a pela web com /link CODIGO.",
      );
    this.app.assertConversationAvailable(id);
  }
  busy(id: string) {
    return [...this.inputs.values()].some((input) => input.id === id);
  }
  async active(access: CommandAccess) {
    const ids = new Set(this.allowed(access).map((item) => item.id));
    const inspection = await this.app.harness.inspect(context);
    return inspection.tasks
      .filter(({ record }) => ids.has(String(record.conversationId)))
      .map(({ record, state }) => ({
        id: String(record.id),
        kind: record.kind,
        conversationId: String(record.conversationId),
        background: record.background,
        abortRequested: record.abortRequested,
        status: record.state.status,
        phase: state.kind,
      }));
  }
  private row(key: string) {
    return this.app.store.get<Receipt>(
      "SELECT * FROM command_receipts WHERE key=?",
      key,
    );
  }
  private result(row: Receipt): CommandResult {
    return row.result
      ? (JSON.parse(row.result) as CommandResult)
      : {
          kind: "command",
          command: parseCommand(row.text)!.name,
          conversationId: row.conversationId,
          status: "uncertain",
          text: "Resultado incerto após interrupção. Verifique a conversa; este comando não será repetido automaticamente.",
        };
  }
  async receipt(id: string, requestId: string, access: CommandAccess) {
    this.authorize(id, access);
    const row = this.row(this.key(id, requestId, access));
    if (!row || row.conversationId !== id) return undefined;
    const result = this.result(row);
    if (result.command !== "compact" || !result.taskId) return result;
    const task = await this.app.harness.getTask(result.taskId, context);
    if (!task || String(task.conversationId) !== id)
      return {
        ...result,
        status: "uncertain",
        text: "A tarefa de compactação não pôde ser verificada. Não foi repetida.",
      };
    const status =
      task.state.status === "terminal"
        ? task.state.outcome.status
        : task.state.status;
    if (
      task.state.status === "terminal" &&
      task.state.outcome.status === "completed" &&
      !task.state.outcome.result.entryId
    )
      return {
        ...result,
        status: "noop",
        text: "Não havia contexto suficiente para compactar. Nenhum resumo foi criado; o histórico foi preservado.",
      };
    return {
      ...result,
      status,
      text: `Compactação ${status} · tarefa ${result.taskId}. O histórico da conversa permanece disponível.`,
    };
  }
  execute(
    id: string,
    requestId: string,
    text: string,
    access: CommandAccess,
  ): Promise<CommandResult> {
    this.authorize(id, access);
    const parsed = parseCommand(text)!;
    if (parsed.name === "chats" && access.source !== "telegram")
      throw new CommandError(
        "Use /chats no Telegram para gerenciar suas conversas exclusivas.",
      );
    const key = this.key(id, requestId, access);
    const existing = this.row(key);
    if (existing) {
      this.authorize(existing.conversationId, access);
      if (
        existing.text !== text ||
        (access.source === "web" && existing.conversationId !== id)
      )
        throw new CommandError("requestId já utilizado com conteúdo diferente");
      const result = this.result(existing);
      this.authorize(result.conversationId, access);
      const pending = this.work.get(key);
      if (!pending && access.source === "telegram")
        this.deliver(
          requestId,
          access.chat,
          result.text,
          result.conversationId,
        );
      return pending ?? Promise.resolve(result);
    }
    const running = this.inputs.get(key);
    if (running) {
      if (running.text !== text || running.id !== id)
        throw new CommandError("requestId já utilizado com conteúdo diferente");
      return this.work.get(key)!;
    }
    if (
      this.app.store.get(
        "SELECT 1 FROM command_receipts WHERE conversationId=? AND requestId=?",
        id,
        requestId,
      )
    )
      throw new CommandError("requestId já utilizado por outro comando");
    if (
      this.app.store.get(
        "SELECT 1 FROM requests WHERE conversationId=? AND requestId=?",
        id,
        requestId,
      )
    )
      throw new CommandError("requestId já utilizado por uma mensagem");
    const operation = async () => {
      const receipt = this.row(key);
      if (receipt) return this.result(receipt);
      const base: CommandResult = {
        kind: "command",
        command: parsed.name,
        conversationId: id,
        text: "",
      };
      const current =
        parsed.name === "model" ||
        parsed.name === "thinking" ||
        parsed.name === "compact"
          ? await this.app.settings.conversation(id)
          : undefined;
      let setting:
        { provider: string; modelId: string; effort: string } | undefined;
      if (parsed.name === "model" && parsed.argument) {
        const model = this.app.models.getModel(
          current!.provider,
          parsed.argument,
        );
        if (!model)
          throw new SettingsError("Modelo não disponível no catálogo do Pi");
        setting = {
          provider: current!.provider,
          modelId: model.id,
          effort: clampThinkingLevel(model, current!.effort),
        };
      }
      if (parsed.name === "thinking" && parsed.argument)
        setting = {
          provider: current!.provider,
          modelId: current!.modelId,
          effort: parsed.argument,
        };
      if (setting) this.app.settings.validate(setting);
      if (
        parsed.name === "compact" &&
        this.app.options.mode === "live" &&
        !this.app.options.models &&
        !(await this.app.models.checkAuth(current!.provider))
      )
        throw new SettingsError(
          "Conecte o provider desta conversa antes de compactar o contexto",
        );
      if (parsed.name === "agents" && parsed.argument) {
        this.authorize(parsed.argument, access);
        await this.app.conversation(parsed.argument);
        // The target can be archived while Durable resolves its conversation.
        // Recheck before writing a receipt or admitting any selection effect.
        this.authorize(parsed.argument, access);
      }
      let chatTitle: string | undefined;
      let chatTarget: string | undefined;
      if (parsed.name === "chats") {
        if (access.source !== "telegram")
          throw new CommandError("Use /chats no Telegram.");
        this.app.telegramChats.binding(access);
        const newChat = /^new(?:\s+([\s\S]+))?$/.exec(parsed.argument);
        if (newChat) {
          chatTitle = newChat[1]?.trim() || "Conversa Telegram";
          if (
            chatTitle.length > 100 ||
            /[\u0000-\u001f\u007f-\u009f]/.test(chatTitle)
          )
            throw new CommandError(
              "Título inválido: use de 1 a 100 caracteres, sem quebras de linha.",
            );
        } else if (parsed.argument) {
          if (!/^[1-9][0-9]{0,15}$/.test(parsed.argument))
            throw new CommandError("Uso: /chats [new TÍTULO|ID]");
          this.app.telegramChats.authorize(parsed.argument, access);
          await this.app.conversation(parsed.argument);
          this.app.telegramChats.authorize(parsed.argument, access);
          chatTarget = parsed.argument;
        }
      }
      let selection: string | undefined;
      this.app.store.run(
        "INSERT INTO command_receipts(key,conversationId,requestId,text,state) VALUES (?,?,?,?,'pending')",
        key,
        id,
        requestId,
        text,
      );
      try {
        if (setting) {
          const saved = await this.app.settings.saveConversation(id, setting);
          base.data = saved;
          base.text = `Modelo: ${saved.modelId}. Esforço: ${saved.effort}.`;
        } else
          switch (parsed.name) {
            case "help":
              base.data =
                access.source === "telegram"
                  ? commandCatalog
                  : webCommandCatalog;
              base.text =
                (access.source === "telegram"
                  ? commandCatalog
                  : webCommandCatalog
                )
                  .map((entry) => `${entry.usage} — ${entry.description}`)
                  .join("\n") +
                "\n//texto envia uma barra literal. /agents não cria agentes; /stop preserva os agendamentos futuros." +
                (access.source === "telegram"
                  ? "\n/new [TÍTULO] cria e seleciona uma nova conversa Telegram; também pode usar /chats new [TÍTULO]."
                  : "");
              break;
            case "chats": {
              if (access.source !== "telegram")
                throw new CommandError("Use /chats no Telegram.");
              if (chatTitle)
                chatTarget = await this.app.create(chatTitle, access);
              if (chatTarget) {
                this.app.assertHandoffAvailable(id);
                this.app.telegramChats.authorize(chatTarget, access);
                selection = chatTarget;
                base.conversationId = chatTarget;
              }
              const conversations = this.app.telegramChats.list(access);
              base.data = conversations;
              const current =
                chatTarget ??
                this.app.store.get<{ conversationId: string }>(
                  "SELECT conversationId FROM telegram_chat_selection WHERE chat=? AND user=?",
                  access.chat,
                  access.user,
                )?.conversationId;
              base.text =
                (chatTarget
                  ? `Conversa Telegram selecionada: ${chatTarget}.\n`
                  : "Conversas Telegram:\n") +
                (conversations
                  .map(
                    (c) =>
                      `${c.id === current ? "→ " : ""}${c.id} · ${c.title}`,
                  )
                  .join("\n") || "Nenhuma conversa Telegram criada.") +
                "\n/new [TÍTULO] ou /chats new [TÍTULO] cria uma conversa; /chats ID seleciona. O histórico antigo continua na web. As próximas mensagens usam contexto exclusivo do Telegram.";
              break;
            }
            case "agents": {
              const conversations = this.allowed(access);
              base.data = conversations;
              if (parsed.argument) {
                if (access.source === "telegram") {
                  this.app.store.db.exec("SAVEPOINT agent_selection");
                  try {
                    this.authorize(parsed.argument, access);
                    if (this.app.telegramChats.dedicated(parsed.argument)) {
                      this.app.telegramChats.authorize(parsed.argument, access);
                      selection = parsed.argument;
                    } else
                      this.app.store.run(
                        "UPDATE telegram SET conversationId=? WHERE chat=? AND user=?",
                        parsed.argument,
                        access.chat,
                        access.user,
                      );
                    this.app.store.db.exec("RELEASE SAVEPOINT agent_selection");
                  } catch (error) {
                    this.app.store.db.exec(
                      "ROLLBACK TO SAVEPOINT agent_selection",
                    );
                    this.app.store.db.exec("RELEASE SAVEPOINT agent_selection");
                    throw error;
                  }
                }
                base.conversationId = parsed.argument;
                base.text = `Conversa selecionada: ${parsed.argument} · ${conversations.find((entry) => entry.id === parsed.argument)!.title}`;
              } else
                base.text =
                  conversations
                    .map((entry) => `${entry.id} · ${entry.title}`)
                    .join("\n") +
                  "\nSelecione com /agents ID. Outras conversas precisam ser vinculadas com /link pela web.";
              break;
            }
            case "model":
            case "thinking": {
              const models = this.app.settings.catalog(current!.provider);
              base.data = { current, models };
              base.text =
                parsed.name === "model"
                  ? `Atual: ${current!.modelId}.\n` +
                    models
                      .map((model) => `${model.id} · ${model.name}`)
                      .join("\n") +
                    "\nUse /model ID."
                  : `Atual: ${current!.effort}. Suportados: ${models.find((model) => model.id === current!.modelId)?.efforts.join(", ") ?? "nenhum"}. Use /thinking ESFORÇO.`;
              break;
            }
            case "tasks": {
              const tasks = await this.active(access);
              base.data = tasks;
              base.text = tasks.length
                ? tasks
                    .map(
                      (task) =>
                        `${task.id} · ${task.kind} · ${task.status} · conversa ${task.conversationId}`,
                    )
                    .join("\n")
                : "Nenhuma execução ativa no Pi.";
              break;
            }
            case "crons": {
              const ids = new Set(this.allowed(access).map((item) => item.id));
              const tasks = this.app.tasks
                .list()
                .filter((task) => ids.has(task.conversationId));
              base.data = tasks;
              base.text = tasks.length
                ? tasks
                    .map(
                      (task) =>
                        `${task.title} · ${task.schedule} (${task.timezone}) · ${task.enabled ? "ativa" : "pausada"} · conversa ${task.conversationId}`,
                    )
                    .join("\n")
                : "Nenhum agendamento. Crie uma rotina pela conversa ou pelo painel Tarefas na web.";
              break;
            }
            case "compact": {
              const conversation = await this.app.conversation(id);
              base.taskId = await conversation.compact(
                parsed.argument || undefined,
                context,
              );
              base.status = "accepted";
              base.text = `Compactação admitida · tarefa ${base.taskId}. Consulte o estado; o histórico será preservado.`;
              break;
            }
            case "stop":
              await (await this.app.conversation(id)).abort(context);
              base.status = "completed";
              base.text =
                "Execução atual interrompida e entradas em fila retiradas. Agendamentos futuros preservados. Efeitos externos em andamento precisam ser verificados; não serão repetidos automaticamente.";
          }
        // Reply and acknowledgement commit together, before HTTP acknowledgement.
        this.app.store.db.exec("BEGIN IMMEDIATE");
        try {
          if (selection && access.source === "telegram") {
            this.app.assertHandoffAvailable(id);
            this.app.telegramChats.select(selection, access);
          }
          this.app.store.run(
            "UPDATE command_receipts SET state='done',result=? WHERE key=?",
            JSON.stringify(base),
            key,
          );
          if (access.source === "telegram")
            this.deliver(
              requestId,
              access.chat,
              base.text,
              base.conversationId,
            );
          this.app.store.db.exec("COMMIT");
        } catch (error) {
          this.app.store.db.exec("ROLLBACK");
          throw error;
        }
        return base;
      } catch (error) {
        if (error instanceof SettingsError) {
          this.app.store.run("DELETE FROM command_receipts WHERE key=?", key);
          throw error;
        }
        this.app.store.run(
          "UPDATE command_receipts SET state='uncertain' WHERE key=?",
          key,
        );
        const result = this.result(this.row(key)!);
        if (access.source === "telegram")
          this.deliver(
            requestId,
            access.chat,
            result.text,
            result.conversationId,
          );
        return result;
      }
    };
    const serial =
      parsed.name === "model" ||
      parsed.name === "thinking" ||
      parsed.name === "compact" ||
      parsed.name === "chats";
    const serialKey =
      parsed.name === "chats" && access.source === "telegram"
        ? `chats:${access.chat}:${access.user}`
        : id;
    this.inputs.set(key, { id, text });
    const work = (
      serial
        ? (this.tails.get(serialKey) ?? Promise.resolve()).catch(() => {})
        : Promise.resolve()
    ).then(() =>
      parsed.name === "compact"
        ? this.app.withProviderAdmission(operation)
        : operation(),
    );
    if (serial) this.tails.set(serialKey, work);
    this.work.set(key, work);
    void work
      .finally(() => {
        this.work.delete(key);
        this.inputs.delete(key);
        if (this.tails.get(serialKey) === work) this.tails.delete(serialKey);
      })
      .catch(() => {});
    return work;
  }
  private deliver(
    requestId: string,
    chat: string,
    text: string,
    conversationId: string,
  ) {
    this.app.store.queueTelegram(
      `command:${requestId}`,
      chat,
      text,
      4000,
      conversationId,
    );
  }
  async close() {
    await Promise.allSettled(this.work.values());
  }
}
