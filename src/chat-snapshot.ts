import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Runtime } from "./runtime.js";

type Snapshot = Awaited<ReturnType<Runtime["snapshot"]>>;
export const CHAT_PAGE_SIZE = 80;
export const CHAT_PREVIEW_CHARS = 4096;
type Message = NonNullable<EntryRecord["model"]>[number];
const messageCache = new WeakMap<Message, ReturnType<typeof previewMessage>>();
const visibleRole = (message: Message) =>
  ["user", "assistant", "toolResult"].includes(message.role);

// Only the human presentation is abbreviated. Durable entries/model context
// are immutable and are never rewritten by this adapter.
function previewMessage(message: Message) {
  let remaining = CHAT_PREVIEW_CHARS;
  let nodes = 128;
  let truncated = false;
  const preview = (value: unknown, depth = 0): unknown => {
    if (--nodes < 0 || depth > 6) {
      truncated = true;
      return "…";
    }
    if (typeof value === "string") {
      const result = value.slice(0, remaining);
      remaining -= result.length;
      if (result.length !== value.length) truncated = true;
      return result;
    }
    if (Array.isArray(value)) {
      if (value.length > 16) truncated = true;
      return value.slice(0, 16).map((item) => preview(item, depth + 1));
    }
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null);
      let fields = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (++fields > 16) {
          truncated = true;
          break;
        }
        // Image bytes and non-rendered reasoning never need to reach the chat.
        if (key === "data" || key === "thinking" || key === "signature") {
          truncated = true;
          continue;
        }
        result[key.slice(0, 128)] = preview(
          (value as Record<string, unknown>)[key],
          depth + 1,
        );
      }
      return result;
    }
    return value;
  };
  return {
    role: message.role,
    ...(message.role === "toolResult"
      ? { toolName: message.toolName.slice(0, 128), isError: message.isError }
      : {}),
    content: preview(message.content),
    previewTruncated: truncated,
  };
}

export function chatSnapshot(snapshot: Snapshot, requestedPage = 0) {
  // Count lightweight message references; never serialize historical bodies.
  let total = 0;
  for (const entry of snapshot.view.entries)
    if (entry.kind !== "app.cua-control")
      for (const message of entry.model ?? [])
        if (visibleRole(message)) total++;
  const pages = Math.max(1, Math.ceil(total / CHAT_PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), pages - 1);
  const end = total - page * CHAT_PAGE_SIZE;
  const start = Math.max(0, end - CHAT_PAGE_SIZE);
  const visible: { key: string; message: ReturnType<typeof previewMessage> }[] =
    [];
  let position = 0;
  for (const entry of snapshot.view.entries) {
    if (entry.kind === "app.cua-control") continue;
    for (const [index, message] of (entry.model ?? []).entries()) {
      if (!visibleRole(message)) continue;
      if (position >= start && position < end) {
        let cached = messageCache.get(message);
        if (!cached) {
          cached = previewMessage(message);
          messageCache.set(message, cached);
        }
        visible.push({ key: `${entry.id}:${index}`, message: cached });
      }
      position++;
    }
  }
  const live = snapshot.view.docs["pi.live"];
  const generation = live?.generation as
    { message?: NonNullable<EntryRecord["model"]>[number] } | undefined;
  return {
    ...snapshot,
    view: {
      conversation: snapshot.view.conversation,
      entries: [],
      docs: live
        ? {
            "pi.live": {
              run: live.run ? true : null,
              generation: generation?.message
                ? { message: previewMessage(generation.message) }
                : null,
            },
          }
        : {},
    },
    history: {
      version: `${total}:${page}:${visible.map((item) => item.key).join(",")}`,
      messages: visible.map((item) => item.message),
      keys: visible.map((item) => item.key),
      page,
      pages,
      total,
    },
  };
}
