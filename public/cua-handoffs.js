// Viewer tickets stay in the authenticated web interface, outside model messages.
export function renderCuaHandoffs(rows, conversation, ui) {
  const { node, t, text, errorText, locale, api, refresh } = ui;
  const label = (tag, source, cls, values = []) =>
    text(node(tag, undefined, cls), () => t(source, values));
  return rows
    .filter((row) => row.state !== "ended")
    .map((row) => {
      const card = node("article", undefined, "action-card");
      card.dataset.state = row.state;
      card.append(
        label("strong", "Intervenção humana · {0}", undefined, [row.server]),
        label("p", "O Pi está pausado para este desktop.", "action-note"),
        label(
          "p",
          "Sem transferência de arquivos ou acesso ao microfone.",
          "action-note",
        ),
      );
      const controls = [];
      const error = node("p", "", "form-error");
      let busy = false;
      const action = (source, operation, body) => {
        const button = label("button", source);
        button.type = "button";
        controls.push(button);
        button.onclick = async () => {
          if (busy) return;
          busy = true;
          controls.forEach((control) => {
            control.disabled = true;
          });
          text(error, "");
          try {
            await api(
              `/api/conversations/${encodeURIComponent(conversation)}/cua-handoffs/${encodeURIComponent(row.id)}/${operation}`,
              "POST",
              body(),
            );
            await refresh(conversation);
          } catch (failure) {
            text(error, () => errorText(failure.message));
            // A failed response can follow a committed or uncertain creation.
            // Refresh the durable state without repeating the mutation.
            try {
              await refresh(conversation);
            } catch {
              /* retain the error */
            }
          } finally {
            busy = false;
            controls.forEach((control) => {
              control.disabled = false;
            });
          }
        };
        return button;
      };
      const check = (suffix, source) => {
        const input = node("input");
        input.type = "checkbox";
        input.id = `cua-${suffix}-${row.id}`;
        const line = node("label", undefined, "checkbox-line");
        line.htmlFor = input.id;
        line.append(input, label("span", source));
        controls.push(input);
        card.append(line);
        return input;
      };
      if (row.state === "pending") {
        const clipboard = check(
          "clipboard",
          "Habilitar clipboard bidirecional nesta intervenção",
        );
        clipboard.checked = row.clipboard === true;
        card.append(
          label(
            "p",
            "Sincroniza o que você copia no Mac e no desktop CUA nos dois sentidos. Senhas e códigos copiados também podem ser compartilhados.",
            "action-note",
          ),
        );
        card.append(
          label(
            "p",
            "Crie um acesso privado de 30 minutos ao mesmo desktop para assumir esta etapa.",
            "action-note",
          ),
          action("Criar acesso privado", "create", () => ({
            clipboard: clipboard.checked,
          })),
          action("Cancelar intervenção", "end", () => ({ cancel: true })),
        );
      } else if (row.state === "active") {
        card.append(
          label(
            "p",
            row.clipboard === true
              ? "Clipboard bidirecional habilitado neste ticket."
              : "Clipboard desabilitado neste ticket.",
            "action-note",
          ),
          label(
            "p",
            "A escolha é fixa neste ticket. Para mudar a permissão, feche todas as abas, devolva o controle e solicite uma nova intervenção.",
            "action-note",
          ),
          label(
            "p",
            "Este ticket permite entrar por 30 minutos. Uma conexão aberta pode continuar após esse prazo. Feche todas as abas do viewer antes de devolver o controle. Sua confirmação não revoga o ticket no serviço.",
            "action-note",
          ),
        );
        const validUntil = Number(row.expiresAt);
        if (Number.isFinite(validUntil))
          card.append(
            label("p", "Ticket válido até {0}", "action-note", [
              new Date(validUntil).toLocaleString(locale()),
            ]),
          );
        try {
          const url = new URL(row.url);
          const params = new URLSearchParams(url.hash.slice(1));
          if (
            validUntil > Date.now() &&
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            url.pathname === "/viewer/" &&
            !url.search &&
            params.get("ticket") &&
            params.get("clipboard") === (row.clipboard === true ? "1" : "0") &&
            [...params.keys()].length === 2
          ) {
            const link = label("a", "Abrir desktop privado");
            link.href = url.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            card.append(link);
          } else {
            card.append(
              label(
                "p",
                "O link não está disponível. O Pi continua pausado.",
                "action-note",
              ),
            );
          }
        } catch {
          card.append(
            label(
              "p",
              "O link não está disponível. O Pi continua pausado.",
              "action-note",
            ),
          );
        }
        const closed = check("closed", "Fechei todas as abas do viewer.");
        const returned = check("returned", "Quero devolver o controle ao Pi.");
        card.append(
          action("Retomar o Pi", "end", () => {
            if (!closed.checked || !returned.checked)
              throw new Error(
                t(
                  "Confirme que fechou todas as abas e quer devolver o controle ao Pi.",
                ),
              );
            return { allTabsClosed: true, controlReturned: true };
          }),
        );
      } else {
        card.append(
          label(
            "p",
            row.state === "creating"
              ? "A criação do acesso está em andamento. Aguarde sem repetir o pedido."
              : "O resultado da criação é incerto. O Pi permanece pausado; verifique o serviço antes de qualquer recuperação.",
            "action-note",
          ),
        );
      }
      card.append(error);
      return card;
    });
}
