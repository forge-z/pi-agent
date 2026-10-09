export function attachConversationEvents(callbacks: {
  refresh: (active: () => boolean) => Promise<void>;
  report?: (error: Error) => void;
}): { start(stream?: EventSource): void; stop(): void };
