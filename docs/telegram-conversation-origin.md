# Conversas Telegram no painel web

O painel web lista as conversas web e as criadas pelo Telegram, incluindo a lixeira. O campo `channel` identifica a origem persistida em `telegram_conversations`; o título, a seleção atual, o estado do bot e o vínculo de entrega de tarefas não mudam essa origem. O ícone Telegram aparece apenas nas conversas de origem Telegram. Históricos e autorização de mensagens continuam separados por canal.

Os eventos da lista compartilham a conexão SSE do histórico selecionado. Uma versão opaca muda quando os metadados das conversas ativas ou excluídas mudam. O navegador consulta a lista, agrupa notificações concorrentes e repete consultas que falham temporariamente. Não há transmissão adicional do histórico para atualizar o menu. O endpoint de eventos da lista também pode ser usado sem uma conversa selecionada.

## Criar outra conversa no Telegram

`/new` cria e seleciona uma conversa Telegram com o título padrão `Conversa Telegram`. `/new TÍTULO` usa o título informado; é um alias de `/chats new TÍTULO`. O menu de comandos do chat privado autorizado inclui `/new`.

Excluir apenas a conversa Telegram selecionada permite criar outra com `/new` enquanto o vínculo de autorização continua válido. Excluir a conversa usada no pareamento revoga esse vínculo. Nesse caso, o bot explica o procedimento: criar uma nova conversa na web, escolher **Vincular Telegram**, enviar `/link CODIGO` e depois usar `/new`.

Se a conversa de pareamento foi excluída antes do primeiro chat privado ser confirmado, é preciso configurar uma nova conexão Telegram no painel web. Um código enviado depois dessa revogação não confirma o chat privado nem recria a autorização inicial.

Essa orientação é uma resposta de controle destinada ao mesmo usuário e chat privado configurados. Ela não concede acesso a históricos, não restaura autorizações antigas e não reativa tarefas ou entregas canceladas. Desconectar o bot ou mudar sua identidade/credencial bloqueia respostas pendentes de controle.

## Possível evolução

Separar a autorização do usuário/bot da conversa de pareamento poderia permitir `/new` depois de apagar todos os chats. Isso exige um estado explícito de autorização e revogação do usuário, distinto dos grants de cada histórico. Uma eventual migração deve exigir nova autorização para vínculos já revogados e criar grants somente para novos chats; não deve inferir consentimento a partir de configurações antigas. Essa evolução não está implementada nesta correção.
