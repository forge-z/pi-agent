import type { Store } from "./store.js";

interface Route {
  chat: string;
  user: string;
  botId: string;
  conversationId: string;
}

function activeRoute(store: Store, conversationId: string): Route | undefined {
  const saved = store.get<{ value: string }>(
    "SELECT value FROM meta WHERE key='telegram:connection'",
  );
  if (!saved) return;
  try {
    const config = JSON.parse(saved.value);
    if (
      config?.enabled !== true ||
      !Number.isSafeInteger(config.bot?.id) ||
      config.bot.id <= 0 ||
      typeof config.userId !== "string" ||
      !/^[1-9]\d*$/.test(config.userId) ||
      typeof config.chatId !== "string" ||
      !/^[1-9]\d*$/.test(config.chatId)
    )
      return;
    const mapping = store.get(
      `SELECT 1 FROM telegram t JOIN telegram_grants g
       ON g.chat=t.chat AND g.user=t.user AND g.conversationId=t.conversationId
       WHERE t.chat=? AND t.user=? AND t.conversationId=?`,
      config.chatId,
      config.userId,
      conversationId,
    );
    if (!mapping) return;
    return {
      chat: config.chatId,
      user: config.userId,
      botId: String(config.bot.id),
      conversationId,
    };
  } catch {
    return;
  }
}

/** Freeze a terminal occurrence's destination, including a skipped notification.
 * Replays must never send an old result to a newly linked conversation/chat. */
export function queueTaskTelegram(
  store: Store,
  conversationId: string,
  requestId: string,
  result: string,
) {
  const task = store.get<{ title: string }>(
    `SELECT t.title FROM task_runs r JOIN tasks t ON t.id=r.taskId
     WHERE r.requestId=? AND t.conversationId=?`,
    requestId,
    conversationId,
  );
  if (!task) return;
  const id = `${conversationId}:${requestId}:task-notification`;
  store.db.exec("SAVEPOINT task_notification");
  try {
    if (!store.get("SELECT 1 FROM task_notifications WHERE id=?", id)) {
      const route = activeRoute(store, conversationId);
      store.run(
        `INSERT INTO task_notifications(id,conversationId,requestId,chat,user,botId,state)
         VALUES (?,?,?,?,?,?,?)`,
        id,
        conversationId,
        requestId,
        route?.chat ?? null,
        route?.user ?? null,
        route?.botId ?? null,
        route ? "queued" : "skipped",
      );
      if (route) {
        store.queueTelegram(
          id,
          route.chat,
          `Tarefa: ${task.title}\n\n${result}`,
        );
        store.run(
          `INSERT INTO task_notification_parts(deliveryId,notificationId)
           SELECT id,? FROM deliveries WHERE substr(id,1,?)=?`,
          id,
          id.length + 1,
          `${id}:`,
        );
      }
    }
    store.db.exec("RELEASE SAVEPOINT task_notification");
  } catch (error) {
    store.db.exec("ROLLBACK TO SAVEPOINT task_notification");
    store.db.exec("RELEASE SAVEPOINT task_notification");
    throw error;
  }
}

/** Called immediately before each send; ordinary command/reply deliveries retain
 * their existing behavior. No token or provider credential is read here. */
export function taskTelegramAuthorized(
  store: Store,
  deliveryId: string,
  users: string[],
  chats: string[],
  botId?: number,
) {
  const receipt = store.get<Route>(
    `SELECT n.* FROM task_notification_parts p JOIN task_notifications n ON n.id=p.notificationId
     WHERE p.deliveryId=?`,
    deliveryId,
  );
  if (!receipt) return true;
  const route = activeRoute(store, receipt.conversationId);
  return (
    !!route &&
    route.chat === receipt.chat &&
    route.user === receipt.user &&
    route.botId === receipt.botId &&
    String(botId) === receipt.botId &&
    users.includes(receipt.user) &&
    chats.includes(receipt.chat)
  );
}
