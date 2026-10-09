// Observe list metadata even when the selected chat is idle.
export function attachConversationEvents(callbacks) {
  let current = null;

  function stop() {
    if (!current) return;
    const previous = current;
    current = null;
    clearTimeout(previous.retry);
    previous.stream.removeEventListener("conversations", previous.refresh);
    if (previous.owned) previous.stream.close();
  }

  function start(stream) {
    stop();
    const state = {
      stream: stream || new EventSource("/api/conversations/events"),
      owned: !stream,
      running: false,
      dirty: false,
      retry: null,
    };
    current = state;
    const active = () => current === state;
    const refresh = async () => {
      if (!active()) return;
      clearTimeout(state.retry);
      state.retry = null;
      state.dirty = true;
      if (state.running) return;
      state.running = true;
      try {
        while (active() && state.dirty) {
          state.dirty = false;
          try {
            await callbacks.refresh(active);
          } catch (error) {
            if (active()) {
              callbacks.report?.(error);
              // A transient GET failure must not consume the only notification
              // for an otherwise settled list. Retry without reconnecting history.
              state.retry = setTimeout(refresh, 1500);
            }
            return;
          }
        }
      } finally {
        state.running = false;
      }
    };
    state.refresh = refresh;
    // Reuse the selected history stream to avoid consuming a second HTTP/1.1
    // browser connection per tab and blocking message submissions.
    state.stream.addEventListener("conversations", refresh);
  }

  return { start, stop };
}
