// Pi Pocket's no-cache worker lifecycle, adapted under MIT (vendor/pi-pocket-LICENSE).
// Conversation state and credentials always come from the authenticated server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
