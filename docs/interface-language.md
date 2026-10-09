# Interface language

Settings now includes **Idioma da interface / Interface language** with Português (Brasil) and English. Portuguese remains the default. The browser saves the validated `pt-BR` or `en` choice under `pi:language`; changing or clearing that preference in another tab updates the current tab. Invalid values fall back to Portuguese, and the selector remains usable if storage is blocked.

The small local catalog uses Portuguese source text as its key and fallback. `i18n-catalog.js` and `i18n.js` load before the application module. Only the original HTML text and accessibility attributes are captured; subsequent conversation content is never scanned. Dynamic UI text uses explicit bindings, so changing language updates existing controls and open menus/dialogs while retaining their values, focus and state. Dates use the selected locale, `html.lang` follows the choice, and known application errors have a separate exact-match allowlist. Missing keys remain in Portuguese; unknown service errors keep their original text.

Conversation titles, user/assistant messages, task titles/prompts, suggestion prompts, tool names/descriptions/arguments/results and MCP-provided form data remain unchanged. Selecting a language does not send a settings mutation or add language instructions to model requests. Stored titles such as `Nova conversa` are treated as data. Sidebar layout, account permissions and Telegram command registration are unchanged by this feature.

## Verification

Automated tests cover both languages, persistence/reload, invalid and unavailable storage, cross-tab updates, missing-key fallback, unknown-error preservation, bound controls and conversation-menu/dialog transitions. Existing composer, slash-menu, tool visibility and MCP reconciliation fixtures run the same production handlers with the translation bindings.

Local Chromium checks against the compiled demo backend cover desktop (1280×900) and mobile (390×844): switching/reloading both languages, storage synchronization, task and rename drafts, destination selections, rename/delete controls and confirmation, preserved manual title `Nova conversa`, and unchanged user/assistant message bodies. Both layouts report no page errors or horizontal overflow. Evidence is available in `/workspace/scratch/interface-language/browser-real-backend.mjs`, `.log` and `.json`, with screenshots alongside them. No external services are involved.
