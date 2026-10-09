// Keep one bounded page in the DOM. All records remain in the snapshot/store.
export function historyWindow(entries, requestedPage = 0, size = 80) {
  const records = [];
  const keys = [];
  for (const entry of entries) {
    // Passive application context remains available to the model and durable store.
    if (entry.kind === "app.cua-control") continue;
    for (const [index, message] of (entry.model || []).entries())
      if (["user", "assistant", "toolResult"].includes(message.role)) {
        records.push(message);
        keys.push(entry.id == null ? null : `${entry.id}:${index}`);
      }
  }
  const pages = Math.max(1, Math.ceil(records.length / size));
  const page = Math.min(Math.max(0, requestedPage), pages - 1);
  const end = records.length - page * size;
  return {
    messages: records.slice(Math.max(0, end - size), end),
    keys: keys.slice(Math.max(0, end - size), end),
    page,
    pages,
    total: records.length,
  };
}
