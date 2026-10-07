# Configurações e tarefas

Abra **Configurações** no menu lateral. O seletor próximo ao compositor altera o modelo e o esforço da conversa atual; o painel define o padrão de novas conversas. As escolhas são persistidas pelo Pi Durable e sobrevivem a reinícios. Conversas existentes continuam com suas próprias escolhas. Aguarde uma conversa terminar antes de trocar seu modelo.

O catálogo vem do provider registrado no Pi AI e os esforços são obtidos por `getSupportedThinkingLevels`. Um ID no catálogo não garante acesso por sua conta ChatGPT. Em modo demo, aparece somente o modelo local; `APP_MODE=live` habilita o catálogo OpenAI. A conexão ChatGPT continua independente da senha web.

## MCP

Cadastre um nome, endpoint Streamable HTTP HTTPS e, quando necessário, bearer token. HTTP é permitido apenas em loopback para mocks locais. Salvar um servidor não conecta contas nem executa ferramentas. **Descobrir ferramentas** conecta o cliente e lê o catálogo; a descoberta não concede permissões. Escolha explicitamente quais ferramentas podem ler e quais podem executar ações. Classifique corretamente cada ferramenta: anotações fornecidas pelo servidor não são uma fronteira de autorização.

Toda ação externa continua exigindo contexto recente de leitura e aprovação explícita. As configurações MCP não podem ser alteradas enquanto houver mensagens em execução ou ações pendentes/incertas. Após alterações, evidências anteriores são invalidadas. Um token não é transferido silenciosamente ao mudar o endpoint: informe/remova o token ou cadastre outro servidor.

Tokens são armazenados no SQLite protegido pelo volume, junto às outras credenciais da aplicação, e nunca retornam nas respostas GET. Proteja o host, os backups e o acesso web. Arquivos de tokens são provisionados pelo operador, não escolhidos livremente pelo painel. `MCP_CONFIG_FILE` serve como configuração inicial; depois de salvar no painel, a configuração persistida no SQLite prevalece. Remover todos os servidores no painel mantém a lista vazia após reinício.

## Tarefas e cron

Em **Tarefas**, escolha título, instrução e conversa de destino. Uma execução única recebe data/hora no fuso selecionado; a repetição usa cron de cinco campos (`minuto hora dia mês dia-da-semana`) e fuso IANA. O padrão é `America/Sao_Paulo`. Por exemplo, `0 8 * * 1-5` agenda às 8h em dias úteis. A expressão `0 8 * * *` agenda diariamente às 8h. A frequência mínima é um minuto; não há cron do sistema operacional nem execução de shell.

O painel mostra a próxima execução e permite pausar, retomar, executar agora, consultar histórico e excluir. **Executar agora** funciona também em tarefas pausadas e não muda a pausa. Pausar ou excluir impede novas ocorrências agendadas; uma ocorrência já admitida continua na fila da conversa. Uma execução única concluída não pode ser reativada como nova ocorrência; crie outra tarefa. O histórico de tarefas excluídas é conservado na base, assim como a conversa e os trabalhos já admitidos.

Cada ocorrência é registrada em uma transação antes de entrar no Pi, com requestId estável. Um reinício retoma a mesma ocorrência sem enviar novamente a solicitação como novo trabalho. Uma tarefa tem no máximo uma ocorrência pendente; a fila do Pi também serializa diferentes tarefas na mesma conversa. Após indisponibilidade, é executada uma ocorrência atrasada por cron e a próxima é calculada a partir do momento atual: não há avalanche de execuções históricas.

O resultado aparece na conversa selecionada, sem envio automático ao Telegram. O estado **Concluída** indica que o agente terminou de responder; propostas de ações externas ainda podem aguardar aprovação na conversa. O serviço precisa estar em execução para cumprir a agenda e usa o mesmo volume persistente e processo proprietário do MVP.

## Referências no código do Pi

As integrações usam o código e os contratos instalados de Pi AI/Pi Durable 1.0.4, sem copiar um segundo executor:

- [Pi AI: catálogo, getSupportedThinkingLevels e clampThinkingLevel](https://github.com/earendil-works/pi/blob/main/packages/ai/src/models.ts).
- [Pi Coding Agent: seletor de modelo](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/model-selector.ts) e [seletor de esforço](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/thinking-selector.ts).
- [Pi Durable: configuração de conversa e agente](https://github.com/earendil-works/pi/blob/main/packages/durable/src/harness/types.ts) e [scheduler interno](https://github.com/earendil-works/pi/blob/main/packages/durable/src/harness/scheduler.ts).
- Pi Pocket (MIT): [catálogo e capacidades](https://github.com/TannerMidd/pi-pocket/blob/main/src/server/models.ts), [configuração persistida](https://github.com/TannerMidd/pi-pocket/blob/main/src/server/commands.ts) e [seletor web](https://github.com/TannerMidd/pi-pocket/blob/main/web/sheets/model.js). Licença e atribuição permanecem em `vendor/` e `THIRD_PARTY_NOTICES.md`.

O scheduler interno do Durable administra execução e recuperação do agente. Como ele não oferece o cadastro de cron com fuso e histórico deste painel, a aplicação mantém apenas a agenda no SQLite e admite as ocorrências por `Conversation.submit`, usando o executor persistente existente. O parser cron é `cron-parser`, com suporte a fuso e horário de verão.
