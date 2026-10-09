import { test } from "node:test";
import assert from "node:assert/strict";
import { interfaceLanguage } from "./interface-fixture.js";

test("Portuguese is the default; English persists across reload and locale follows the choice", () => {
  const page = interfaceLanguage();
  assert.equal(page.root.lang, "pt-BR");
  assert.equal(page.i18n.t("Configurações"), "Configurações");
  page.i18n.setLanguage("en");
  assert.equal(page.i18n.t("Configurações"), "Settings");
  assert.equal(page.root.lang, "en");
  assert.equal(page.i18n.locale(), "en-US");
  const reload = interfaceLanguage(page.storage.get("pi:language")!);
  assert.equal(reload.i18n.language(), "en");
  assert.equal(reload.i18n.t("Excluir conversa"), "Delete conversation");
  reload.i18n.setLanguage("pt-BR");
  assert.equal(reload.i18n.locale(), "pt-BR");
});

test("invalid preferences, missing translations and unavailable storage fall back safely", () => {
  const invalid = interfaceLanguage("unexpected");
  assert.equal(invalid.root.lang, "pt-BR");
  invalid.i18n.setLanguage("en");
  assert.equal(
    invalid.i18n.t("Texto ainda sem tradução."),
    "Texto ainda sem tradução.",
  );
  assert.equal(
    invalid.i18n.t("Detalhe {0} sem tradução.", ["<script>"]),
    "Detalhe <script> sem tradução.",
  );
  invalid.sync("en");
  assert.equal(invalid.i18n.language(), "en");
  invalid.sync("unexpected");
  assert.equal(invalid.i18n.language(), "pt-BR");
  const blocked = interfaceLanguage(null, true);
  blocked.i18n.setLanguage("en");
  assert.equal(blocked.i18n.t("Nova conversa"), "New conversation");
});

test("existing UI bindings change language without replacing controls or translating their data", () => {
  const page = interfaceLanguage();
  const attributes = new Map<string, string>();
  const button = {
    textContent: "",
    value: "rascunho",
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
  const title = { textContent: "Nova conversa" };
  const message = { textContent: "Tarefas/Excluir conversa" };
  page.i18n.text(button, () => page.i18n.t("Renomear"));
  page.i18n.attr(button, "aria-label", () =>
    page.i18n.t("Ações para {0}", [title.textContent]),
  );
  page.i18n.setLanguage("en");
  assert.equal(button.textContent, "Rename");
  assert.equal(attributes.get("aria-label"), "Actions for Nova conversa");
  assert.equal(button.value, "rascunho");
  assert.equal(title.textContent, "Nova conversa");
  assert.equal(message.textContent, "Tarefas/Excluir conversa");
  page.i18n.setLanguage("pt-BR");
  assert.equal(button.textContent, "Renomear");
  page.i18n.plain(button, "Excluir conversa");
  page.i18n.setLanguage("en");
  assert.equal(button.textContent, "Excluir conversa");
});

test("cross-tab changes update bound controls, while unrelated preferences are ignored", () => {
  const page = interfaceLanguage();
  const label = { textContent: "" };
  page.i18n.text(label, "Conectar ChatGPT");
  page.sync("en");
  assert.equal(label.textContent, "Connect ChatGPT");
  page.sync("pt-BR", "pi:appearance");
  assert.equal(label.textContent, "Connect ChatGPT");
  page.sync(null, null);
  assert.equal(label.textContent, "Conectar ChatGPT");
});

test("only known interface errors are localized; external error details stay unchanged", () => {
  const page = interfaceLanguage("en");
  assert.equal(
    page.i18n.errorText("Conversa não encontrada"),
    "Conversation not found",
  );
  assert.equal(page.i18n.errorText("Excluir conversa"), "Excluir conversa");
  assert.equal(
    page.i18n.errorText("external-service: texto original"),
    "external-service: texto original",
  );
});
