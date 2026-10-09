# MCP: etapa externa por URL e metadados do servidor

A aplicação aceita os pedidos humanos normais de `elicitation/create` e o erro MCP `-32042` (`UrlElicitationRequiredError` no SDK). São fluxos diferentes.

No pedido normal de `elicitation/create`, a ferramenta ainda aguarda a resposta humana. Aceitar, recusar ou cancelar responde ao servidor pelo pedido que está em andamento. O fluxo existente de pausa estruturada e `resume` também permanece separado e só usa a decisão explícita da pessoa.

Quando a ferramenta termina com `-32042`, a aplicação preserva somente as elicitations URL validadas do erro. Cada solicitação aparece como um cartão humano na conversa, com `kind: "url"` e `payload.source: "url_required_error"`. Essa origem é criada pelo backend; um pedido normal não pode defini-la. A chamada original fica **incerta**, mesmo depois de a pessoa marcar uma etapa externa como concluída.

Concluir a etapa externa, recusar ou cancelar registra somente a decisão local. Não envia `resume`, não repete a ferramenta original e não confirma que uma escrita terminou no serviço. Todas as solicitações dessa chamada devem ser respondidas antes de registrar separadamente o resultado verificado. A aplicação bloqueia novas chamadas nesse servidor e conversa enquanto houver solicitação pendente ou resultado incerto. Chamadas enfileiradas da mesma conversa só verificam admissão depois de a chamada anterior gravar o resultado e todos os cartões. O encerramento drena essa fila, sem enviar escritas ou retomadas que ainda não iniciaram. Após conferir o serviço, a pessoa pode usar a reconciliação já existente; uma chamada futura requer uma nova solicitação.

Os cartões do erro sobrevivem ao reinício, pois não dependem de uma resposta JSON-RPC ainda em andamento. Pedidos normais com resposta aguardada expiram ao reiniciar. A conversa e a configuração da conexão vinculam cada cartão à chamada original: outra conversa não pode responder a ele, e aceitar é bloqueado quando o endpoint ou a credencial muda. Recusar ou cancelar uma etapa externa continua sendo uma operação local.

## Validação e limites

As URLs devem ser HTTPS, sem usuário ou senha embutidos. URLs malformadas, HTTP, JavaScript e espaços/caracteres de controle são recusados antes de publicar cartões. Query e fragmento são permitidos para preservar o handoff que o serviço solicita. Não há navegação automática pela aplicação.

O backend aplica o schema URL do SDK, remove metadados extras e limita cada erro a oito solicitações com IDs distintos. A URL tem limite de 4.096 caracteres; a mensagem, 2.000; o ID, 200. Uma lista inválida não publica parte dos cartões. Cartões e estado incerto são gravados em uma transação; falha de armazenamento desfaz os cartões e mantém o resultado conservadoramente incerto, sem repetir a ferramenta.

A mensagem bruta do erro e seus campos arbitrários não são exibidos. URLs e mensagens dos cartões são dados do servidor: o link é uma etapa externa explicitamente solicitada à pessoa e não é prova de resultado da ferramenta.

## Instruções retornadas na inicialização

Para servidores em modo `direct`, a aplicação inclui o texto de `client.getInstructions()` na configuração de ferramentas que chega ao modelo. Esse texto é metadado **não confiável**, apresentado como string JSON citada, com uma regra explícita de subordinação ao pedido do usuário e às regras da aplicação sobre permissões e segredos. Não autoriza decisões humanas, mudanças de política, vazamento de segredos ou repetição de efeitos incertos.

Cada servidor fornece no máximo 4.000 caracteres ao contexto; o conjunto serializado fica limitado a 16.000 caracteres, preservando JSON completo. O bearer token conhecido da conexão é removido desse texto. A aplicação continua expondo os nomes e schemas das ferramentas registradas. Não carrega prompts ou recursos genericamente e não cria ferramentas CUA.

`test/mcp-url-required.test.ts` usa somente servidores SDK e HTTP em loopback, URLs externas fictícias e respostas do provider faux. Verifica publicação atômica, URLs inválidas, vínculo de conversa/credencial, cancelamento, concorrência, reinício, ausência de repetição de escrita e de `resume`, preservação do fluxo normal e presença dos metadados no pedido real ao provider local. Não visita as URLs nem testa serviços externos ou credenciais reais.
