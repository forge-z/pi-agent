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

No Telegram, `/chats` lista conversas exclusivas, `/chats new TÍTULO` cria e seleciona uma conversa, e `/chats ID` troca o contexto. A próxima mensagem normal cria uma conversa Telegram automaticamente quando ainda não há seleção; o histórico antigo permanece na web. A seleção de chats não altera o vínculo usado pelos crons existentes.

O menu lateral marca a conversa web vinculada ao Telegram com o ícone Telegram. Excluir uma conversa move seu histórico para a lixeira por sete dias, pausa suas tarefas e revoga o vínculo Telegram. A lista de excluídas mostra o prazo e permite restaurar ou **Excluir agora**, com confirmação da exclusão definitiva. Restaurar não reativa tarefas nem vínculos.

Conversas que já estavam excluídas recebem sete dias a partir da primeira inicialização desta versão. A limpeza automática verifica prazos a cada minuto e retoma operações interrompidas após reiniciar. Execuções, entregas ou intervenções pendentes e dependências de outros históricos bloqueiam a limpeza até serem resolvidas; a conversa pode ser restaurada enquanto a exclusão definitiva não tiver começado. A limpeza remove os registros da conversa nos bancos locais, preservando outros chats e credenciais globais; não remove cópias de backup do volume.

O Telegram registra esse catálogo e `/chats` no menu nativo `/` do chat privado autorizado depois da primeira mensagem. O diálogo mostra o estado do registro; menus de outros chats e menus alheios existentes são preservados. Novas respostas usam HTML seguro para negrito, itálico, links e código, com divisão de mensagens longas antes de entrar na fila persistente.

Resultados de tarefas e crons também entram nessa fila quando a conversa mantém o vínculo privado ativo. A autorização é conferida antes de cada envio; revogação cancela partes pendentes e resultados incertos não são reenviados. Resultados de ocorrências concluídas sem vínculo não são enviados depois de uma conexão nova. Veja [entrega de tarefas](docs/cron-telegram-delivery.md).

| Variável                             | Uso                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_PASSWORD` / `WEB_PASSWORD_FILE` | Senha da interface, com no mínimo 12 caracteres. O arquivo tem precedência quando definido. Separe essa senha do login do provider.                                                                                                                                                                        |
| `APP_ORIGIN`                         | Origem exata da interface (`scheme://host[:port]`); também protege requisições de escrita contra origem diferente.                                                                                                                                                                                         |
| `COOKIE_SECURE`                      | Defina `true` quando a interface estiver atrás de TLS.                                                                                                                                                                                                                                                     |
| `APP_MODE`                           | `demo` por padrão; `live` ativa o provider OpenAI.                                                                                                                                                                                                                                                         |
| `MODEL_ID`                           | Modelo no modo live; padrão `gpt-6.1-sol`.                                                                                                                                                                                                                                                                 |
| `DATA_DIR`                           | Diretório das bases SQLite; padrão `./data`.                                                                                                                                                                                                                                                               |
| `MCP_CONFIG_FILE`                    | Arquivo JSON opcional com servidores MCP HTTP(S). Veja [docs/mcp.example.json](docs/mcp.example.json).                                                                                                                                                                                                     |
| Telegram                             | Conecte pelo botão **Telegram** no cabeçalho da conversa com o token do bot, seu ID numérico de usuário e a conversa atual como referência do vínculo e dos crons existentes. O fluxo usa polling privado; veja [implantação](docs/deployment.md#telegram) e [arquitetura](docs/architecture.md#telegram). |

Os arquivos Compose não declaram nem encaminham variáveis ou secrets Telegram. Token e ID de usuário são configurados pela interface e persistem no volume. No Coolify, recarregue a definição Compose do `main` antes de excluir as variáveis antigas; na primeira migração, informe o token do mesmo bot na UI. Uma conexão já salva continua usando o SQLite existente.

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
