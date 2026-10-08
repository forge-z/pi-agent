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

As allowlists de usuário e chat continuam obrigatórias. `/link CODIGO` mantém o vínculo por código de uso único gerado na web e concede acesso àquela conversa para aquele usuário naquele chat. Vínculos existentes são migrados somente para sua conversa atual. Para disponibilizar outra conversa, gere e consuma seu próprio código na web. Depois, `/agents ID` pode alternar entre essas conversas já vinculadas; não revela nem permite adivinhar as demais conversas da web.

`/tasks` e `/crons` usam o mesmo conjunto autorizado. Atualizações repetidas são vinculadas a usuário, chat e conteúdo por um fingerprint; um `update_id` reapresentado com outro conteúdo ou identidade é recusado. Os comandos existentes `/link CODIGO`, `/approve ID` e `/deny ID` continuam disponíveis no Telegram. O lote não registra menu de comandos nem conecta contas reais.

### Vínculo e abertura do bot

Copie `/link CODIGO` em **Vincular Telegram** e envie-o ao bot no aplicativo Telegram. Colá-lo no chat web devolve uma orientação para o canal correto, sem consumir o código ou enviá-lo ao modelo. O transporte trata `/link` e `/start` antes do catálogo de comandos gerais, incluindo espaços e quebras de linha ao redor. `/start` sem código somente orienta; nunca cria vínculo por ser o primeiro usuário a escrever.

`TELEGRAM_BOT_USERNAME` é opcional e não é um segredo. Configure o username público do seu próprio bot, sem `@`, para habilitar **Abrir bot no Telegram** (`https://t.me/USERNAME?start=CODIGO`) e comandos como `/link@USERNAME CODIGO` e `/help@USERNAME`. A comparação do username ignora maiúsculas/minúsculas. Sem essa configuração, continue usando os comandos sem sufixo. Comandos dirigidos a outro bot ou a uma identidade não configurada são ignorados. O payload `/start CODIGO` passa pela mesma validação de código de uso único, expiração e allowlists de `/link`.

O vínculo, o grant, o consumo do código, o recibo do update e sua confirmação ficam na mesma transação. Repetir o update depois de reiniciar não consome outro código nem troca novamente a conversa. A confirmação usa o ledger persistente; envios incertos não são reenviados automaticamente. Nenhuma confirmação inclui o código.

O [pi-telegram de badlogic, commit `cb34008`](https://github.com/badlogic/pi-telegram/blob/cb34008460b6c1ca036d92322f69d87f626be0fc/index.ts) é uma extensão MIT do Coding Agent: despacha `/start`, ajuda e controles antes de `pi.sendUserMessage`, faz polling e associa o primeiro remetente de DM quando não existe usuário autorizado. A ordem de despacho e a normalização são referências úteis. Aqui permanecem o webhook, as allowlists de usuário/chat, o código explícito por conversa e as entregas duráveis; a extensão não foi importada, nem seu pareamento automático adotado. Streaming de previews, mídias e anexos daquela extensão seriam incrementos separados.

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
