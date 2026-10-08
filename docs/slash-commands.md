# Comandos na web e no Telegram

Digite `/` no início do compositor para abrir as sugestões. Setas mudam a seleção; Enter ou Tab insere o comando sem enviar. Escape fecha a lista. Depois, preencha os argumentos e envie com Enter. Ctrl+Enter continua inserindo uma linha; Shift/Alt+Enter e a confirmação de composição IME continuam disponíveis. No celular, toque na sugestão.

| Comando                 | Resultado                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/agents [id]`          | Lista ou seleciona uma conversa existente. Na web, abre um seletor; no Telegram, use o ID informado. Não cria agentes nem subagentes.                                                        |
| `/model [id]`           | Consulta o catálogo do provider ou muda o modelo da conversa atual. O esforço atual é ajustado para uma opção suportada pelo novo modelo.                                                    |
| `/thinking [esforço]`   | Consulta ou altera o esforço para um valor suportado pelo modelo.                                                                                                                            |
| `/compact [instruções]` | Admite uma tarefa de compactação real no Pi Durable e informa seu estado. Preserva o histórico; não limpa nem reinicia a conversa.                                                           |
| `/tasks`                | Mostra as execuções ativas do Harness, separadas dos agendamentos. O painel web atualiza enquanto estiver aberto; no Telegram, retorna uma consulta daquele momento.                         |
| `/crons`                | Abre o painel de agendamentos na web ou lista as agendas autorizadas no Telegram, incluindo execuções únicas.                                                                                |
| `/stop`                 | Interrompe o trabalho comum da conversa atual e retira entradas em fila. Não pausa nem exclui crons futuros. Tarefas de segundo plano seguem o comportamento padrão de `Conversation.abort`. |
| `/help`                 | Lista os oito comandos deste lote.                                                                                                                                                           |

Comandos desconhecidos ou argumentos inválidos não são enviados ao modelo. Para enviar uma mensagem que começa com uma barra literal, use duas: `//help` envia `/help` como texto. Os comandos pertencem aos transportes web/Telegram; o prompt de uma ocorrência agendada não se transforma em comando por começar com `/`.

Modelo e esforço usam as mesmas validações das configurações. Alterações são bloqueadas durante uma solicitação ativa. O catálogo vem do Pi AI; constar no catálogo não garante que a conta conectada tenha acesso. A autenticação web e o login ChatGPT permanecem independentes.

## Conversas autorizadas no Telegram

Na nova conexão, o operador informa o próprio ID numérico no diálogo Telegram, escolhe a conversa e confere a prévia. A primeira mensagem privada desse usuário grava o chat e autoriza somente a conversa escolhida. Não é preciso configurar allowlists de usuário ou chat. Vínculos já existentes são preservados sem concessões mais amplas. `/link CODIGO` e `/start CODIGO` continuam como compatibilidade para pares explícitos antigos e orientação, mas não são o caminho principal. Depois de autorizadas, `/agents ID` pode alternar entre conversas vinculadas; não revela nem permite adivinhar as demais conversas da web.

`/tasks` e `/crons` usam o mesmo conjunto autorizado. Atualizações repetidas são vinculadas a usuário, chat e conteúdo por recibos persistidos; um `update_id` reapresentado com outro conteúdo ou identidade é recusado. Os comandos existentes `/link CODIGO`, `/approve ID` e `/deny ID` continuam disponíveis no Telegram. O fluxo com contas reais não foi validado neste ambiente.

O catálogo de oito comandos também é registrado no menu nativo do Telegram (`/`) depois do vínculo do chat privado. O registro usa `getMyCommands` e `setMyCommands` apenas nesse chat, com português, língua do usuário e fallback padrão. Menus globais, de grupos e de outros chats permanecem intactos. Um menu alheio existente é preservado e aparece como conflito no diálogo Telegram. A sincronização verifica o estado após reiniciar e não repete uma escrita incerta sem nova conexão explícita. Os comandos de vínculo e aprovação continuam aceitos, mas ficam fora das oito sugestões porque dependem de códigos ou IDs específicos.

### Conexão e migração

Abra o botão **Telegram** no cabeçalho da conversa, escolha a conversa atual como destino e confira a prévia. Informe o token e seu ID numérico de usuário, então selecione **Conectar**. O diálogo valida o token com `getMe`, consulta `getWebhookInfo` e, quando o polling pode começar, faz uma consulta inicial bem-sucedida com timeout zero antes de buscar updates `message` em long polling de 25 segundos. Veja a [referência oficial de `getUpdates`](https://core.telegram.org/bots/api#getupdates).

Um webhook já configurado permanece intacto durante **Conectar**. Para migrar um bot que tem webhook ativo, use a ação separada de troca para polling: ela mostra a URL do webhook e a identidade esperada do bot e exige confirmação explícita. A aplicação não registra webhook nem expõe uma rota pública para atualizações.

Com o polling conectado, a primeira DM privada do usuário informado registra o chat e concede a conversa selecionada. Mensagens de outro usuário ou de grupos não ganham acesso por esse vínculo. A conexão não precisa de allowlists, segredo de webhook ou `TELEGRAM_BOT_USERNAME`. A ação **Desconectar** interrompe o polling, preserva a conversa e mantém o token no SQLite privado. Uma identidade diferente da já registrada fica bloqueada para evitar colisões de offsets e grants; não há fluxo de troca de bot.

O offset persistente avança após admissão ou rejeição terminal. Falhas temporárias de rede ou de gravação deixam o update pendente para nova tentativa. Recibos de duplicatas permanecem armazenados, e envios cujo resultado é incerto não são repetidos automaticamente. Um único processo owner mantém o poller; conflito bloqueia a conexão e aparece como status.

Variáveis de token antigas ou arquivo de token não conectam automaticamente. Se o campo de token estiver vazio, o operador pode escolher explicitamente reutilizar uma dessas fontes ao conectar. `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_ALLOWED_CHATS` e `TELEGRAM_WEBHOOK_SECRET` (incluindo arquivos correspondentes) são obsoletas para o fluxo novo; os valores existentes servem só de dica de migração, sem iniciar polling ou ampliar grants. Configuração parcial não impede o serviço web de iniciar. `/link CODIGO` e `/start CODIGO` permanecem apenas para compatibilidade com vínculos explícitos antigos e orientação.

O [pi-telegram de badlogic no commit `cb34008460b6c1ca036d92322f69d87f626be0fc`](https://github.com/badlogic/pi-telegram/blob/cb34008460b6c1ca036d92322f69d87f626be0fc/index.ts) é uma referência de polling e despacho de comandos antes de enviar texto ao modelo. A [API oficial do Telegram](https://core.telegram.org/bots/api#getupdates) documenta o contrato de `getUpdates`. A extensão não foi importada.

## Recibos, retomada e efeitos externos

O servidor interpreta comandos antes de admitir uma solicitação ao modelo. Um `requestId` da web ou `update_id` do Telegram identifica o comando e seu recibo persistido. Tentativas simultâneas reutilizam a mesma operação; uma repetição após outra alteração ou um reinício retorna o recibo anterior, sem reaplicar a mudança. Reutilizar o identificador para outro texto é recusado, inclusive entre mensagem e comando.

Uma compactação usa `Conversation.compact`; o `taskId` retornado fica no recibo. A web consulta o estado por GET, sem repetir o POST. Como essa API não recebe `requestId`, existe uma janela entre a admissão no Durable e a gravação do recibo na base da aplicação. Se o processo morrer nessa janela, o recibo fica **incerto**: a tarefa que já foi admitida pode continuar pelo Durable, mas a aplicação não admite outra às cegas. Verifique o histórico e as execuções antes de fazer um novo pedido.

Quando a tarefa termina sem criar uma entrada de resumo, a interface mostra **Sem alterações**, explicando que não havia contexto suficiente para compactar. Esse resultado vem de `TaskOutcome.result.entryId`; a conclusão da tarefa sozinha não é apresentada como prova de um resumo criado.

Interromper trabalho não desfaz efeitos já iniciados no serviço MCP. O rastreio MCP continua marcando resultados desconhecidos como incertos e exigindo verificação, sem replay automático. Respostas de comandos no Telegram entram no mesmo ledger de entregas persistentes. Uma falha após iniciar o envio fica incerta e nunca provoca reenvio automático. A compactação no Telegram recebe confirmação de admissão; `/tasks` consulta seu trabalho enquanto estiver ativo. O acompanhamento terminal por GET é oferecido na web.

## Referências fixadas na versão instalada

O projeto usa Pi AI/Pi Durable **1.0.4**, cujo código corresponde ao commit `7c10bd4337495ee613f2224843ecdf349b80d1df`:

- [TUI experimental Durable](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/experimental/durable/tui.ts): trata `/model`, `/tasks`, `/agents` e `/compact` antes de enviar texto ao controlador. `/agents` seleciona conversas; esforço e interrupção são ações de teclado nesse terminal.
- [Controlador do TUI](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/experimental/durable/runtime.ts): usa o Harness existente e instala suas extensões explicitamente. Extensões de subagentes daquele terminal não são herdadas por este aplicativo.
- [Contratos públicos do Harness](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/harness/types.ts): `Conversation.configure`, `compact`, `abort`, `Harness.inspect` e `getTask` fornecem as operações usadas aqui. Nenhum módulo privado do executor foi importado.
- [Capacidades de modelos no Pi AI](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/models.ts): catálogo, esforços suportados e ajuste de esforço.
- [Comandos do Coding Agent](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/core/slash-commands.ts): pertencem ao CLI completo, não ao pacote Durable. Este lote não importa esse CLI nem promete `/new`, `/tree`, criação de agentes, skills ou comandos de login herdados.

`/thinking`, `/crons`, `/stop` e `/help` são comandos explícitos deste aplicativo em torno dessas APIs. A agenda continua no SQLite com cron-parser; a execução permanece no único processo dono do Harness.
