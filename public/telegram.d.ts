export interface TelegramBotIdentity {
  id: number;
  username?: string;
  firstName?: string;
}

export interface TelegramStatusSnapshot {
  state: string;
  configured: boolean;
  hasToken: boolean;
  userId: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  bot: TelegramBotIdentity | null;
  lastSuccessAt: number | null;
  error: string | null;
  webhookUrl: string | null;
  webhookVersion?: string | null;
  awaitingFirstMessage: boolean;
  commandMenu?: TelegramCommandMenuSnapshot;
}

export interface TelegramCommandMenuSnapshot {
  state:
    "waiting" | "syncing" | "ready" | "retrying" | "conflict" | "uncertain";
  message: string;
}

export interface TelegramApi {
  (
    path: string,
    method?: string,
    data?: Record<string, unknown>,
  ): Promise<TelegramStatusSnapshot>;
}

export interface TelegramUIOptions {
  getConversationId(): string | null;
  getConversationTitle(): string | null;
}

export declare function attachTelegramUI(
  api: TelegramApi,
  options: TelegramUIOptions,
): void;
