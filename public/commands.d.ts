export interface CommandEntry {
  name: string;
  usage?: string;
  description?: string;
}

export interface CommandElement {
  id: string;
  hidden: boolean;
  className: string;
  textContent: string;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  append(...children: CommandElement[]): void;
  replaceChildren(...children: CommandElement[]): void;
  querySelector?(selector: string): CommandElement | null;
  scrollIntoView?(options?: ScrollIntoViewOptions): void;
}

export interface CommandInput extends CommandElement {
  value: string;
  focus(): void;
  setSelectionRange?(start: number, end: number): void;
  dispatchEvent(event: Event): boolean | void;
}

export interface CommandAutocomplete {
  close(): void;
  handleKeydown(event: CommandKeyEvent): boolean;
  update(): Promise<void>;
  getCommands(): Promise<CommandEntry[]>;
  readonly open: boolean;
}

export interface CommandKeyEvent {
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  keyCode: number;
  preventDefault(): void;
}

export declare function canDispatchCommandResult(
  command: string,
  hasArgs: boolean,
  sourceConversation: string,
  currentConversation: string | null,
  sourceStillAvailable?: boolean,
): boolean;

export declare function refreshConversationSnapshot<TSnapshot>(
  conversationId: string,
  dependencies: {
    getConversationId(): string | null;
    loadConversations(): Promise<unknown>;
    api(path: string): Promise<TSnapshot>;
    render(snapshot: TSnapshot): void;
  },
): Promise<boolean>;

export declare function slashPrefix(value: unknown): string | null;

export declare function createSlashAutocomplete<
  TElement extends CommandElement,
>(options: {
  api(path: string): Promise<{ commands?: CommandEntry[] }>;
  document: { createElement(tagName: string): TElement };
  input: TElement & CommandInput;
  list: TElement;
}): CommandAutocomplete;
