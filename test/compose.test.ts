import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const file of ["docker-compose.yml", "docker-compose.secrets.yml"]) {
  test(`${file} declares no legacy Telegram environment variables or secrets`, () => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    // Coolify prevents removing variables referenced by the Compose definition.
    // Telegram credentials belong to the authenticated UI and persistent SQLite.
    assert.doesNotMatch(
      source,
      /TELEGRAM_|telegram_bot_token|telegram_webhook_secret/,
    );
  });
}
