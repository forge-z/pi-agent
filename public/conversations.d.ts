export type ManagedConversation = {
  id: string;
  title: string;
  deletedAt?: number | null;
  purgeAt?: number | null;
  channel?: "web" | "telegram";
  telegramLinked?: boolean;
};

export type ConversationManagementCallbacks = {
  getConversationId: () => string | null;
  getConversations: () => ManagedConversation[];
  loadConversations: () => Promise<ManagedConversation[]>;
  selectConversation: (id: string, title: string) => Promise<void>;
  closeSidebar: () => void;
  afterDelete: (id: string, wasActive: boolean) => Promise<void>;
  onRenamed?: (conversation: ManagedConversation) => void;
  report?: (error: Error) => void;
};

export function attachConversationManagementUI(
  api: (path: string, method?: string, data?: unknown) => Promise<unknown>,
  callbacks: ConversationManagementCallbacks,
): {
  render: (items?: ManagedConversation[]) => void;
  showActiveView: () => void;
  isDeletedView: () => boolean;
  getDeletedConversations: () => ManagedConversation[];
  refreshDeletedView: () => Promise<boolean>;
  reset: () => void;
};
