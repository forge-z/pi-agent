import { commandCatalog } from "./commands.js";
import type { Store } from "./store.js";
import type { TelegramApi } from "./telegram-connection.js";

interface BotCommand {
  command: string;
  description: string;
}
interface Receipt {
  state: "pending" | "done" | "uncertain";
  commands: BotCommand[];
}
export interface TelegramCommandMenuStatus {
  state:
    "waiting" | "syncing" | "ready" | "retrying" | "conflict" | "uncertain";
  message: string;
}
export const telegramCommandCatalog = commandCatalog.map(
  ({ name, description }) => ({
    command: name,
    description,
  }),
);
const same = (a: BotCommand[], b: BotCommand[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Only the authorized private chat; never default, all-private, or group scopes. */
export class TelegramCommandMenu {
  status: TelegramCommandMenuStatus = {
    state: "waiting",
    message:
      "Menu de comandos: aguardando a primeira mensagem privada autorizada.",
  };
  private checked = "";
  private retryAt = 0;
  private explicit = false;
  constructor(
    private store: Store,
    private retryMs = 30000,
  ) {}
  newConnection() {
    this.checked = "";
    this.retryAt = 0;
    this.explicit = true;
    this.status = {
      state: "waiting",
      message:
        "Menu de comandos: aguardando a primeira mensagem privada autorizada.",
    };
  }
  private read(key: string): Receipt | undefined {
    const row = this.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      key,
    );
    return row ? (JSON.parse(row.value) as Receipt) : undefined;
  }
  private save(key: string, value: Receipt) {
    this.store.run(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  private parse(value: unknown): BotCommand[] {
    if (!Array.isArray(value) || value.length > 100)
      throw new Error("Invalid command list");
    return value.map((item: unknown) => {
      if (!item || typeof item !== "object") throw new Error("Invalid command");
      const c = item as {
        command?: unknown;
        description?: unknown;
        is_ephemeral?: unknown;
      };
      if (
        typeof c.command !== "string" ||
        !/^[a-z0-9_]{1,32}$/.test(c.command) ||
        typeof c.description !== "string" ||
        !c.description.length ||
        c.description.length > 256 ||
        c.is_ephemeral === true
      )
        throw new Error("Invalid command");
      return { command: c.command, description: c.description };
    });
  }
  async sync(
    api: TelegramApi,
    config: { botId: number; chatId: string | null; languageCode?: string },
    signal: AbortSignal,
  ) {
    if (!config.chatId) {
      this.status = {
        state: "waiting",
        message:
          "Menu de comandos: aguardando a primeira mensagem privada autorizada.",
      };
      return;
    }
    const languages = [
      ...new Set([
        "",
        "pt",
        ...(config.languageCode ? [config.languageCode] : []),
      ]),
    ];
    const identity = JSON.stringify([
      config.botId,
      config.chatId,
      languages,
      telegramCommandCatalog,
    ]);
    if (identity === this.checked || Date.now() < this.retryAt) return;
    this.status = {
      state: "syncing",
      message: "Verificando o menu de comandos deste chat…",
    };
    let writing: string | undefined;
    try {
      const scope = { type: "chat", chat_id: Number(config.chatId) };
      const targets = [];
      // Read every relevant language before changing any menu. Other scopes are untouched.
      for (const language_code of languages) {
        const key = `telegram:menu:${config.botId}:${config.chatId}:${language_code || "all"}`;
        const receipt = this.read(key);
        const commands = this.parse(
          await api.call("getMyCommands", { scope, language_code }, signal),
        );
        const equal = same(commands, telegramCommandCatalog);
        if (
          !equal &&
          commands.length &&
          !(receipt?.state === "done" && same(commands, receipt.commands))
        ) {
          this.status = {
            state: "conflict",
            message:
              "Já existe outro menu neste chat privado. Ele foi preservado; o Pi não substituiu comandos alheios.",
          };
          this.checked = identity;
          return;
        }
        if (!equal && receipt && receipt.state !== "done" && !this.explicit) {
          this.status = {
            state: "uncertain",
            message:
              "O registro anterior do menu ficou incerto. Não foi repetido. Reconecte explicitamente para uma nova verificação e tentativa.",
          };
          this.checked = identity;
          return;
        }
        targets.push({ key, language_code, equal });
      }
      for (const target of targets) {
        signal.throwIfAborted();
        if (!target.equal) {
          this.save(target.key, {
            state: "pending",
            commands: telegramCommandCatalog,
          });
          writing = target.key;
          const result = await api.call(
            "setMyCommands",
            {
              scope,
              language_code: target.language_code,
              commands: telegramCommandCatalog,
            },
            signal,
          );
          if (result !== true)
            throw new Error("Command registration not confirmed");
        }
        this.save(target.key, {
          state: "done",
          commands: telegramCommandCatalog,
        });
        writing = undefined;
      }
      this.status = {
        state: "ready",
        message:
          "Menu de comandos registrado. Digite / na conversa privada com o bot.",
      };
      this.checked = identity;
    } catch {
      if (writing) {
        // Even a failed receipt write leaves the preceding durable pending marker.
        try {
          this.save(writing, {
            state: "uncertain",
            commands: telegramCommandCatalog,
          });
        } catch {
          /* recovery reads the remote menu before any write */
        }
        this.status = {
          state: "uncertain",
          message:
            "O registro do menu ficou incerto. O envio não será repetido sem verificar o estado no Telegram.",
        };
      } else {
        this.status = {
          state: "retrying",
          message:
            "Não foi possível verificar o menu de comandos. A conexão continua e a consulta será tentada novamente.",
        };
      }
      this.retryAt = Date.now() + this.retryMs;
    } finally {
      this.explicit = false;
    }
  }
}
