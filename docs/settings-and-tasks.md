# Configurações e tarefas

Os atalhos web/Telegram e suas referências no Pi estão em [Comandos na web e no Telegram](slash-commands.md).

Abra **Configurações** no menu lateral. O seletor próximo ao compositor altera o modelo e o esforço da conversa atual; o painel define o padrão de novas conversas. As escolhas são persistidas pelo Pi Durable e sobrevivem a reinícios. Conversas existentes continuam com suas próprias escolhas. Aguarde uma conversa terminar antes de trocar seu modelo.

O catálogo vem do provider registrado no Pi AI e os esforços são obtidos por `getSupportedThinkingLevels`. Um ID no catálogo não garante acesso por sua conta ChatGPT. Em modo demo, aparece somente o modelo local; `APP_MODE=live` habilita o catálogo OpenAI. A conexão ChatGPT continua independente da senha web.

## Detalhes de ferramentas

O botão **Ferramentas** no cabeçalho mostra ou oculta chamadas e resultados comuns da conversa. No celular ele usa o ícone de plugue, com nome acessível e alvo de toque de 44 px. O estado pressionado indica que os detalhes estão visíveis. A preferência é salva neste navegador e vale para o histórico e as novas atualizações; se o armazenamento estiver bloqueado, funciona durante a sessão aberta.

Respostas do Pi, aprovações, solicitações de interação MCP, erros e resultados que declaram pausa, espera ou incerteza continuam visíveis. Ocultar detalhes não cancela nem autoriza uma ferramenta. As chamadas mostram os argumentos como texto recolhível; o controle não altera o contexto enviado ao modelo.

Links HTTP(S) nas respostas abrem em outra aba, com `noopener noreferrer`, preservando a conversa. Uma etapa manual no viewer não aceita nem retoma uma interação MCP automaticamente: volte ao Pi para decidir pelo controle explícito da solicitação.

## MCP

Cadastre um nome, endpoint MCP HTTP(S) e, quando necessário, bearer token. HTTPS é obrigatório fora de loopback. O transporte principal é Streamable HTTP; diante de resposta 404 ou 405, o cliente tenta o transporte legado SSE. Esta versão não oferece transporte `stdio`. Salvar um servidor não executa ferramentas. **Descobrir ferramentas** consulta automaticamente as páginas do catálogo, até 2.000 ferramentas e 100 cursores; uma falha de descoberta fica isolada naquele servidor e não esconde os demais.

Cada servidor usa `mode: "legacy"` ou `mode: "direct"`. O modo ausente equivale a `legacy`, preservando as configurações anteriores sem migração automática. Em `legacy`, `readTools` e `actionTools` continuam controlando as ferramentas: o agente lê contexto antes de propor uma ação, e a aplicação aguarda a confirmação do operador. As anotações do servidor não determinam permissões.

Em `direct`, as ferramentas descobertas são registradas diretamente no agente persistente e chamadas no servidor MCP. Não há uma confirmação adicional da aplicação por chamada. `allowedTools` é opcional: se omitido, todas as ferramentas descobertas são permitidas; se for `[]`, nenhuma ferramenta é permitida; uma lista restringe a chamada aos nomes informados. `deniedTools` é opcional e sempre prevalece sobre `allowedTools`. `readTools` e `actionTools` continuam presentes para compatibilidade com configurações legacy; não use essa classificação como promessa de leitura sem efeitos colaterais.

O painel oferece migração explícita para `direct`. Ela preserva a união dos nomes em `readTools` e `actionTools` na lista permitida, sem alterar o modo do servidor até essa escolha. Revise a lista e as permissões do serviço: `execute` não consegue garantir que uma ferramenta seja somente de leitura, e uma descrição ou nome de ferramenta não prova isso. Limites e autorizações nativos do próprio serviço continuam valendo.

Cada chamada direta tem rastreio durável e replay inseguro: uma chamada que ficou incerta após falha ou reinício não é reenviada automaticamente. A interface permite registrar o resultado depois de verificá-lo no serviço externo; esse registro não repete a chamada. Falhas de descoberta ou chamada são apresentadas sem incluir o token.

Quando um servidor pede uma resposta MCP nativa `form` ou `url`, a chamada fica aguardando uma decisão na interface. Um formulário aceito é validado contra o schema enviado pelo servidor; o endereço de uma interação `url` só é aceito se usar HTTPS e não incluir credenciais. A aplicação nunca aceita essas solicitações automaticamente. Se o processo reiniciar antes da resposta, uma solicitação pendente expira e a chamada fica incerta; ela não pode ser aceita depois do reinício.

Pausas de Executor também aparecem na interface se a resposta da ferramenta declarar no nível superior `status: "paused"` ou `paused: true`, e incluir `executionId` mais `resumePayload` ou `interaction`. A resposta humana aceita, recusa ou cancela essa pausa por uma chamada separada à ferramenta MCP `resume`, com o mesmo `executionId` e, se informado, conteúdo JSON. O servidor precisa expor `resume` e ela precisa estar permitida em `allowedTools` e ausente de `deniedTools`. A pausa reconhecida depende desse formato; variações de schema de outras versões não são inferidas. A pausa declarada permanece pendente depois de reiniciar, mas se o processo falhar durante a chamada `resume`, o resultado fica incerto e não é aceito nem repetido automaticamente.

Uma pausa sem os campos necessários fica incerta, sem tentativa de adivinhar a retomada. Aceitar exige a mesma conexão e credencial da chamada original. Quando `resume` está bloqueada ou a credencial mudou, recusar/cancelar encerra apenas a espera local; a execução remota permanece pausada. O resultado completo de uma retomada fica no SQLite; a mensagem enviada ao agente é limitada a 28.000 caracteres e recuperada de forma idempotente após reinício.

As configurações MCP ficam bloqueadas enquanto houver mensagens ativas, ações legacy pendentes/em execução/incertas ou chamadas direct em execução/pausadas/incertas. Após alterações, evidências de leitura anteriores são invalidadas. Um token não é transferido silenciosamente ao mudar o endpoint: informe/remova o token ou cadastre outro servidor.

Tokens são armazenados no SQLite protegido pelo volume, junto às outras credenciais da aplicação, e nunca retornam nas respostas GET. Proteja o host, os backups e o acesso web. Arquivos de tokens são provisionados pelo operador, não escolhidos livremente pelo painel. A senha web e a proteção same-origin permanecem independentes das credenciais MCP. `MCP_CONFIG_FILE` serve como configuração inicial; depois de salvar no painel, a configuração persistida no SQLite prevalece. Remover todos os servidores no painel mantém a lista vazia após reinício.

## Tarefas e cron

Em **Tarefas**, escolha título, instrução e conversa de destino. Uma execução única recebe data/hora no fuso selecionado; a repetição usa cron de cinco campos (`minuto hora dia mês dia-da-semana`) e fuso IANA. O padrão é `America/Sao_Paulo`. Por exemplo, `0 8 * * 1-5` agenda às 8h em dias úteis. A expressão `0 8 * * *` agenda diariamente às 8h. A frequência mínima é um minuto; não há cron do sistema operacional nem execução de shell.

O painel mostra a próxima execução e permite pausar, retomar, executar agora, consultar histórico e excluir. **Executar agora** funciona também em tarefas pausadas e não muda a pausa. Pausar ou excluir impede novas ocorrências agendadas; uma ocorrência já admitida continua na fila da conversa. Uma execução única concluída não pode ser reativada como nova ocorrência; crie outra tarefa. O histórico de tarefas excluídas é conservado na base, assim como a conversa e os trabalhos já admitidos.

Cada ocorrência é registrada em uma transação antes de entrar no Pi, com requestId estável. Um reinício retoma a mesma ocorrência sem enviar novamente a solicitação como novo trabalho. Uma tarefa tem no máximo uma ocorrência pendente; a fila do Pi também serializa diferentes tarefas na mesma conversa. Após indisponibilidade, é executada uma ocorrência atrasada por cron e a próxima é calculada a partir do momento atual: não há avalanche de execuções históricas.

O resultado aparece na conversa selecionada, sem envio automático ao Telegram. O estado **Concluída** indica que o agente terminou de responder; propostas de ações externas ainda podem aguardar aprovação na conversa. O serviço precisa estar em execução para cumprir a agenda e usa o mesmo volume persistente e processo proprietário do MVP.

### Criar pela conversa

O agente recebe `tasks_list` e `tasks_create` junto com as ferramentas MCP, em conversas novas e existentes. Por exemplo: “Crie uma rotina para resumir esta conversa todos os dias às 8h no horário de Brasília”. Informe o pedido completo, a recorrência e o fuso; o assistente deve perguntar quando faltar uma dessas informações. A ferramenta exige fuso IANA, grava a tarefa na conversa atual e retorna ID, próxima execução e agenda. O painel **Tarefas** consulta o mesmo agendador e a mesma base.

A criação é permitida somente durante uma solicitação ativa do usuário pela web ou Telegram. Uma execução agendada ou notificação interna pode consultar a agenda, mas não criar novas rotinas. A criação e seu recibo são gravados juntos; a retomada da mesma chamada depois de um crash reutiliza a tarefa, inclusive se uma data única já passou. Uma tarefa excluída não é recriada pelo replay. Pausa, execução manual e exclusão continuam sendo operações do painel autenticado. Permissões e aprovações MCP permanecem aplicáveis quando o prompt agendado for executado.

## Referências no código do Pi

As integrações usam o código e os contratos instalados de Pi AI/Pi Durable 1.0.4, sem copiar um segundo executor:

- [Pi AI: catálogo, getSupportedThinkingLevels e clampThinkingLevel](https://github.com/earendil-works/pi/blob/main/packages/ai/src/models.ts).
- [Pi Coding Agent: seletor de modelo](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/model-selector.ts) e [seletor de esforço](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/thinking-selector.ts).
- [Pi Durable: configuração de conversa e agente](https://github.com/earendil-works/pi/blob/main/packages/durable/src/harness/types.ts) e [scheduler interno](https://github.com/earendil-works/pi/blob/main/packages/durable/src/harness/scheduler.ts).
- Pi Durable: [registro de extensões e ferramentas](https://github.com/earendil-works/pi/blob/main/packages/durable/src/harness/registry.ts) e [execução com intenção persistida e política de replay](https://github.com/earendil-works/pi/blob/main/packages/durable/src/harness/tool.ts). O adapter MCP usa esse registro e declara `replay: "unsafe"`; a recuperação do Pi não repete chamadas interrompidas com essa política.
- Pi Durable: [resolução das ferramentas de cada agente](https://github.com/earendil-works/pi/blob/main/packages/durable/src/harness/agent.ts) combina extensões pelo registry; instalar `mcp-direct` não substitui `personal-assistant`. O [exemplo de tarefas duráveis](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/12-tasks.ts) demonstra checkpoints e retomada. Essas tarefas de execução são distintas das rotinas de calendário da aplicação, que usam cron-parser e submetem ocorrências ao Harness existente.
- Pi TUI: [renderer Markdown](https://github.com/earendil-works/pi/blob/main/packages/tui/src/components/markdown.ts) usa o lexer do Marked. O renderer web segue essa referência de parsing, criando nós DOM por tags permitidas; não incorpora o renderer ANSI do terminal. Histórico e respostas parciais usam o mesmo renderer, sem interpretar HTML nem carregar imagens externas.
- Pi Pocket (MIT): [catálogo e capacidades](https://github.com/TannerMidd/pi-pocket/blob/main/src/server/models.ts), [configuração persistida](https://github.com/TannerMidd/pi-pocket/blob/main/src/server/commands.ts) e [seletor web](https://github.com/TannerMidd/pi-pocket/blob/main/web/sheets/model.js). Licença e atribuição permanecem em `vendor/` e `THIRD_PARTY_NOTICES.md`.

O scheduler interno do Durable administra execução e recuperação do agente. Como ele não oferece o cadastro de cron com fuso e histórico deste painel, a aplicação mantém apenas a agenda no SQLite e admite as ocorrências por `Conversation.submit`, usando o executor persistente existente. O parser cron é `cron-parser`, com suporte a fuso e horário de verão.
