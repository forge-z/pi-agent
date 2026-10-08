# Pi Personal Agent

Um assistente pessoal com histórico durável, interface web e integração opcional com Telegram e ferramentas MCP. No modo `demo`, as conversas ficam locais e recebem respostas simuladas; nenhuma conta externa é necessária. No modo `live`, o login OpenAI é feito pela interface. Ferramentas MCP podem usar o modo `legacy`, com propostas e confirmação da aplicação, ou `direct`, com execução direta e as permissões nativas do serviço.

## Rodar localmente

Requer Node.js 24 ou superior.

```sh
npm ci
WEB_PASSWORD='local-demo-password' APP_ORIGIN=http://127.0.0.1:3000 APP_MODE=demo npm run dev
```

Abra <http://127.0.0.1:3000> e entre com a senha `local-demo-password`. Ela é um valor de demonstração explícito para teste local; escolha outra senha longa antes de qualquer uso real e nunca use esse exemplo em produção. A aplicação salva seus dados em `./data` por padrão.

Para produção com Docker Compose ou Coolify, use [docs/deployment.md](docs/deployment.md). Visão dos componentes, persistência e limites estão em [docs/architecture.md](docs/architecture.md).

## Configuração

O painel **Configurações** permite gerenciar servidores MCP e os padrões de modelo/esforço. O seletor na conversa aplica a escolha somente à conversa atual. **Tarefas** permite criar execuções únicas ou cron, pausar, executar agora e acompanhar o histórico. Veja [configurações e tarefas](docs/settings-and-tasks.md) para uso, persistência e referências no código do Pi.

Digite `/` no compositor para encontrar `/agents`, `/model`, `/thinking`, `/compact`, `/tasks`, `/crons`, `/stop` e `/help`. Eles também funcionam no Telegram, com acesso limitado às conversas vinculadas. Consulte [comandos e referências do Pi](docs/slash-commands.md).

| Variável                                                            | Uso                                                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_PASSWORD` / `WEB_PASSWORD_FILE`                                | Senha da interface, com no mínimo 12 caracteres. O arquivo tem precedência quando definido. Separe essa senha do login do provider. |
| `APP_ORIGIN`                                                        | Origem exata da interface (`scheme://host[:port]`); também protege requisições de escrita contra origem diferente.                  |
| `COOKIE_SECURE`                                                     | Defina `true` quando a interface estiver atrás de TLS.                                                                              |
| `APP_MODE`                                                          | `demo` por padrão; `live` ativa o provider OpenAI.                                                                                  |
| `MODEL_ID`                                                          | Modelo no modo live; padrão `gpt-6.1-sol`.                                                                                          |
| `DATA_DIR`                                                          | Diretório das bases SQLite; padrão `./data`.                                                                                        |
| `MCP_CONFIG_FILE`                                                   | Arquivo JSON opcional com servidores MCP HTTP(S). Veja [docs/mcp.example.json](docs/mcp.example.json).                              |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` / variantes `_FILE` | Segredos opcionais para habilitar Telegram, por variável ou arquivo. Exige também as allowlists de usuário e chat.                  |
| `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_ALLOWED_CHATS`                  | IDs separados por vírgula; ambos são exigidos quando o bot está ativo.                                                              |
| `TELEGRAM_BOT_USERNAME`                                             | Username público opcional do bot, sem `@`; habilita abertura com código e sufixos dirigidos ao bot.                                 |

Use `npm run build` para compilar; `npm start` inicia `dist/src/main.js`. O runtime usa Pi Durable 1.0.4, Pi AI 1.0.4, SQLite integrado do Node e o SDK MCP por HTTP.

## Operação

O workspace web usa uma senha compartilhada para um operador; não há usuários individuais nem RBAC. No modo live, clique em **Sign in with ChatGPT** para completar o OAuth interativo. Essa conta é independente da senha da interface.

Antes de conectar ferramentas MCP, revise as permissões do serviço e a lista `allowedTools`/`deniedTools`. O modo `direct` chama ferramentas sem confirmação adicional da aplicação, e uma chamada `execute` não garante que a ferramenta seja somente de leitura. O modo `legacy` mantém listas `readTools`/`actionTools`, leitura antes da proposta e confirmação do operador. Consulte [configurações e tarefas](docs/settings-and-tasks.md), [arquitetura e limites](docs/architecture.md) e [implantação](docs/deployment.md).

## Licenças

O código deste projeto está sob MIT, veja [LICENSE](LICENSE). Avisos e referências de terceiros estão em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Verificação

```sh
npm run check
npm run lint
npm run build
npm test
```

Veja [evidências e limites da verificação](docs/verification.md).

Os testes usam provider faux, MCP HTTP em loopback e transporte Telegram mock. Incluem `SIGKILL` durante geração, efeito externo e envio; o teste aguarda 31 segundos pela expiração do lock antes de retomar. Nenhuma conta real é usada.

## Aparência

A interface tem temas **Azul**, **Cinza** e **Pi**, com modos **Claro**, **Escuro** e **Automático** independentes. Pi segue o visual do [site oficial](https://pi.dev): papel quente no claro, azul profundo no escuro, títulos serifados, bordas retas e grade discreta. Os seletores ficam na entrada e no rodapé da navegação; no celular, abra o menu. A preferência é salva no navegador. O modo automático acompanha o sistema.

O logo é o oficial do Pi, os ícones são Phosphor e as fontes são servidas localmente. Veja [a direção visual](docs/design.md) e [as capturas e verificações](docs/verification.md#refinamento-visual-paletas-e-modos-de-aparência).
