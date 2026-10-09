# Renomear, excluir e recuperar conversas

Cada conversa tem um botão de ações na barra lateral, também disponível no
celular. Renomear aceita um título de 1 a 100 caracteres, remove espaços nas
pontas e rejeita caracteres de controle. O título escolhido permanece após
novas mensagens, inclusive quando é "Nova conversa" ou "Conversa recuperada".
A lista, o cabeçalho do chat e o próximo status do Telegram usam esse título.

Excluir exige marcar a confirmação e clicar em **Excluir conversa**. Cancelar
ou fechar antes da confirmação não altera os dados. A conversa passa para
**Conversas excluídas**, de onde pode ser restaurada. O histórico Durable,
pedidos, ações, resultados e recibos continuam armazenados; não há endpoint
de exclusão permanente. Excluir a conversa aberta fecha seu stream, limpa seu
rascunho pendente local e abre outra conversa disponível ou uma nova. Excluir
outra conversa mantém a seleção atual.

## Proteções e recuperação

- A exclusão responde 409 enquanto existirem admissões ou comandos em curso,
  tarefas Durable não terminadas, pedidos ou execuções agendadas pendentes,
  ações pendentes/em execução/incertas, MCP pausado/incerto ou interação aberta,
  ou entrega Telegram em envio/incerta. É preciso aguardar ou resolver esse
  trabalho; excluir não cancela efeitos externos.
- Uma reserva impede novas admissões durante a inspeção assíncrona. A última
  verificação e as alterações locais são feitas em uma transação SQLite.
- Agendamentos locais são pausados e mantidos na agenda. Conversas excluídas
  não aceitam mensagens, comandos, alteração para habilitar tarefas, novas
  execuções ou vínculo Telegram. Triggers protegem a criação/reativação de
  agendamentos após uma admissão concorrente.
- Códigos de vínculo, mapeamentos e autorizações Telegram são revogados.
  Entregas ainda pendentes da conversa são canceladas; entregas enviadas e
  demais registros mantêm seu estado. Metadados de propriedade identificam
  respostas e recibos; aliases antigos são reconhecidos. Para entregas antigas
  sem proprietário/recibo, o chat revogado é usado como alternativa
  conservadora, sem cancelar registros com proprietário conhecido diferente.
- Entradas futuras de uma conexão revogada não produzem respostas de erro
  automáticas. Um `/link CODIGO` explícito no chat já configurado pode vincular
  uma conversa disponível. Configuração aguardando o primeiro DM não refaz o
  vínculo antigo após restaurar: é necessária nova conexão explícita.
- Restaurar recupera título e histórico. As tarefas continuam pausadas e o
  Telegram requer novo vínculo explícito. Não são reenviadas entregas antigas
  nem repetidos resultados externos.

## Causas e regressões verificadas

Antes desta mudança não havia fluxo de renomear ou excluir. A recuperação
automática de conversas no startup não distinguia conversas ocultadas e o
replay de resultados terminais podia readmitir mensagens. O marcador de
exclusão persistido e a supressão do replay em conversas excluídas preservam
esses registros sem reabrir execução.

Os testes em `test/conversation-management.test.ts` verificam validação,
persistência do título manual, autorização HTTP/origem, confirmação,
histórico e ledger após reinício, recuperação, tarefas pausadas, vínculos
revogados, entregas suprimidas e corrida com admissão. Os testes adicionais
em `test/telegram-connection.test.ts` exercitam o poller real contra Telegram
falso: renomear no status, exclusão antes/depois do primeiro DM, recuperação
sem vínculo automático e `/link` explícito para outra conversa. Os testes de
UI em `test/conversations-ui.test.ts` verificam ações, validação, cancelamento,
erro de exclusão, recuperação e seleção atual. Todos os dados são temporários;
nenhum serviço ou dado de produção foi usado.

Validação da versão inicial: `npm test` passou 204/204 testes; `npm run check`,
`npm run lint`, `npm run build` e `git diff --check` passaram. Chromium real
validou desktop e celular, incluindo validação nativa do formulário,
cancelamento, exclusão ativa/inativa, recuperação com lista atualizada,
histórico após recarregar e título sem espaços com 100 caracteres. Não houve
erros de página. A revisão independente encontrou e verificou as correções
de ingress revogado no Telegram, aliases de entregas, título manual,
validação de campos ocultos e menus truncados no celular.

Uma regressão adicional pausa a consulta Durable durante `/agents ID` e exclui
a conversa de destino a partir de outra conversa. O comando verifica novamente
a autorização depois da consulta e dentro da transação que altera o vínculo;
não cria recibo de seleção nem aponta o Telegram para a conversa excluída.
Restaurar depois dessa corrida continua exigindo vínculo explícito.
Os 37 testes focados de comandos, gerenciamento de conversas e conexão
Telegram passaram após essa correção, assim como TypeScript, lint e build.
