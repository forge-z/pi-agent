import { lexer } from "/marked.js";

const INLINE_TAGS = {
  strong: "strong",
  em: "em",
  del: "del",
  codespan: "code",
};
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"];

/** Convert Marked's token stream to DOM without parsing generated HTML. */
export function renderMarkdown(source, doc = document) {
  const text = String(source);
  const fragment = doc.createDocumentFragment();
  // A large single token (for example base64 in JSON) can overflow the
  // JavaScript engine's regexp stack. Never send unbounded text to Marked.
  if (text.length > 32768) return renderTextPreview(text, doc);
  // A small string can still make the lexer spend seconds backtracking on
  // unbalanced emphasis. Bound syntax BEFORE parsing; counting tokens after
  // lexer() returns cannot protect clicks or the message submission handler.
  if (hasExcessiveSyntax(text)) return renderTextPreview(text, doc);
  try {
    const tokens = lexer(text);
    const pending = [tokens];
    let objects = 0;
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== "object") continue;
      if (++objects > 1500) return renderTextPreview(text, doc);
      pending.push(
        ...Object.values(value).filter(
          (item) => item && typeof item === "object",
        ),
      );
    }
    appendBlocks(fragment, tokens, doc);
  } catch {
    // Malformed/deeply nested output must not interrupt the whole snapshot.
    return renderTextPreview(text, doc);
  }
  return fragment;
}

// Bound parser work without trying to duplicate Markdown's block/inline grammar.
// Ordinary prose, URL separators and JSON punctuation are not recursive syntax.
// Literal code is counted too: exemption heuristics can hide dangerous prose
// when Marked consumes a delimiter as part of an HTML token, link or table cell.
function hasExcessiveSyntax(text) {
  let syntax = 0;
  let emphasis = 0;
  let backticks = 0;
  let listMarkers = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    let listMarker =
      (character === "-" || character === "+") &&
      (index === 0 || /\s/.test(text[index - 1])) &&
      /\s/.test(text[index + 1] || "");
    if (
      (character === "." || character === ")") &&
      /\s/.test(text[index + 1] || "")
    ) {
      let start = index - 1;
      while (start >= 0 && index - start <= 9 && /[0-9]/.test(text[start]))
        start--;
      listMarker = start < index - 1 && (start < 0 || /\s/.test(text[start]));
    }
    if (listMarker) {
      syntax++;
      if (++listMarkers > 256) return true;
    } else if ("*_~".includes(character)) {
      syntax++;
      if (++emphasis > 256) return true;
    } else if (character === "`") {
      syntax++;
      if (++backticks > 256) return true;
    } else if ("[]()<>!\\#".includes(character)) {
      syntax++;
    }
    if (syntax > 512) return true;
  }
  return false;
}

export function renderTextPreview(source, doc = document) {
  const text = String(source);
  const fragment = doc.createDocumentFragment();
  const pre = doc.createElement("pre");
  pre.append(doc.createTextNode(text.slice(0, 32768)));
  fragment.append(pre);
  if (text.length > 32768) {
    const notice = doc.createElement("p");
    notice.className = "text-preview-notice";
    notice.append(
      doc.createTextNode(
        "Prévia de texto extenso. O conteúdo completo permanece salvo na conversa.",
      ),
    );
    const download = doc.createElement("button");
    download.type = "button";
    download.textContent = "Baixar texto completo";
    download.onclick = () => {
      const url = URL.createObjectURL(
        new Blob([text], { type: "text/plain;charset=utf-8" }),
      );
      const link = doc.createElement("a");
      link.href = url;
      link.download = "pi-mensagem.txt";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    fragment.append(notice, download);
  }
  return fragment;
}

function appendBlocks(parent, tokens, doc) {
  for (const token of tokens || []) {
    switch (token.type) {
      case "space":
        break;
      case "heading": {
        const heading = doc.createElement(
          HEADING_TAGS[token.depth - 1] || "h6",
        );
        appendInline(heading, token.tokens, doc);
        parent.append(heading);
        break;
      }
      case "paragraph": {
        const paragraph = doc.createElement("p");
        appendInline(paragraph, token.tokens, doc);
        parent.append(paragraph);
        break;
      }
      case "text":
        appendInline(parent, token.tokens, doc, token.text ?? token.raw);
        break;
      case "code": {
        const pre = doc.createElement("pre");
        const code = doc.createElement("code");
        const language = String(token.lang || "")
          .trim()
          .split(/\s+/)[0];
        if (language && /^[a-zA-Z0-9_-]{1,32}$/.test(language))
          code.setAttribute("class", `language-${language}`);
        code.append(doc.createTextNode(token.text || ""));
        pre.append(code);
        parent.append(pre);
        break;
      }
      case "list":
        appendList(parent, token, doc);
        break;
      case "blockquote": {
        const quote = doc.createElement("blockquote");
        appendBlocks(quote, token.tokens, doc);
        parent.append(quote);
        break;
      }
      case "hr":
        parent.append(doc.createElement("hr"));
        break;
      case "table":
        appendTable(parent, token, doc);
        break;
      case "html":
        parent.append(doc.createTextNode(token.raw ?? token.text ?? ""));
        break;
      default:
        appendInline(parent, token.tokens, doc, token.text ?? token.raw ?? "");
    }
  }
}

function appendList(parent, token, doc) {
  const list = doc.createElement(token.ordered ? "ol" : "ul");
  if (token.ordered && Number.isSafeInteger(token.start) && token.start > 1)
    list.setAttribute("start", String(token.start));

  for (const item of token.items || []) {
    const li = doc.createElement("li");
    for (const child of item.tokens || []) {
      if (child.type === "list") {
        appendList(li, child, doc);
      } else if (child.type === "paragraph") {
        const paragraph = doc.createElement("p");
        appendInline(paragraph, child.tokens, doc);
        li.append(paragraph);
      } else if (child.type === "text") {
        appendInline(li, child.tokens, doc, child.text ?? child.raw ?? "");
      } else {
        appendBlocks(li, [child], doc);
      }
    }
    list.append(li);
  }
  parent.append(list);
}

function appendTable(parent, token, doc) {
  const table = doc.createElement("table");
  const head = doc.createElement("thead");
  const headerRow = doc.createElement("tr");
  for (const cell of token.header || []) {
    const th = doc.createElement("th");
    appendInline(th, cell.tokens, doc, cell.text ?? "");
    headerRow.append(th);
  }
  head.append(headerRow);
  table.append(head);

  const body = doc.createElement("tbody");
  for (const row of token.rows || []) {
    const tr = doc.createElement("tr");
    for (const cell of row) {
      const td = doc.createElement("td");
      appendInline(td, cell.tokens, doc, cell.text ?? "");
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  parent.append(table);
}

function appendInline(parent, tokens, doc, fallback = "") {
  if (!tokens?.length) {
    if (fallback) parent.append(doc.createTextNode(String(fallback)));
    return;
  }

  for (const token of tokens) {
    const tag = INLINE_TAGS[token.type];
    if (tag) {
      const element = doc.createElement(tag);
      if (token.type === "codespan")
        element.append(doc.createTextNode(token.text ?? ""));
      else appendInline(element, token.tokens, doc, token.text ?? "");
      parent.append(element);
      continue;
    }

    if (token.type === "link") {
      const href = safeHref(token.href);
      if (!href) {
        parent.append(doc.createTextNode(token.raw ?? token.text ?? ""));
      } else {
        const anchor = doc.createElement("a");
        anchor.setAttribute("href", href);
        if (/^https?:/i.test(href)) {
          anchor.setAttribute("target", "_blank");
          anchor.setAttribute("rel", "noopener noreferrer");
        }
        appendInline(anchor, token.tokens, doc, token.text ?? "");
        parent.append(anchor);
      }
      continue;
    }

    if (token.type === "image") {
      parent.append(doc.createTextNode(token.text || ""));
      continue;
    }

    if (token.type === "br") {
      parent.append(doc.createElement("br"));
      continue;
    }

    if (token.type === "escape") {
      parent.append(doc.createTextNode(token.text ?? token.raw ?? ""));
      continue;
    }

    // Raw HTML and every unrecognized token remain inert text.
    parent.append(doc.createTextNode(token.raw ?? token.text ?? ""));
  }
}

function safeHref(value) {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f]/.test(value))
    return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    if (url.protocol !== "mailto:" && (url.username || url.password))
      return null;
    return url.href;
  } catch {
    return null;
  }
}
