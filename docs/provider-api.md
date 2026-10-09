# Providers e chaves de API

Em `APP_MODE=live`, o catálogo contém somente os providers registrados: OpenAI, Anthropic e DeepSeek. OpenAI mantém **Sign in with ChatGPT** e também aceita chave de API. Anthropic usa a API padrão da Anthropic com chave de API; a aplicação não registra OAuth Anthropic nem executa a CLI Claude.

DeepSeek usa o provider nativo do Pi, com chave armazenada ou `DEEPSEEK_API_KEY` provisionada pelo operador. Seu catálogo é o do SDK instalado, sem transporte ou mapeamento de modelos próprio. O SDK instalado oferece `deepseek-flash` e `deepseek-v4-pro` pelo endpoint de Chat Completions em `https://api.deepseek.com`, conforme a [documentação oficial DeepSeek](https://api-docs.deepseek.com/) e o [catálogo de modelos](https://api-docs.deepseek.com/quick_start/pricing). Isso não implica suporte à Responses API ou compatibilidade integral com todos os recursos OpenAI.

O adaptador nativo usa `thinking.type` para ativar/desativar raciocínio, `reasoning_effort` e `reasoning_content` no ciclo de ferramentas, conforme o [guia oficial de thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/). Os esforços oferecidos pela interface vêm de cada modelo do catálogo Pi; a aplicação não inventa equivalências entre providers. O teste de transporte intercepta localmente o `fetch` do SDK e verifica streaming de raciocínio/ferramentas, preservação do raciocínio e do resultado da ferramenta na requisição seguinte, `max_tokens`, ausência de `store` e papel `system` em vez de `developer`. Esse teste não confirma acesso remoto, disponibilidade, cobrança ou todos os recursos multimodais do serviço.

A aplicação usa o login e a resolução de credenciais do Pi AI 1.0.4. Salvar uma chave não faz uma chamada de validação ao serviço: confirma somente formato, método disponível e gravação local. O acesso ao modelo depende da conta e será verificado pelo serviço na execução solicitada.

Cada provider tem uma credencial armazenada. Escolher provider, modelo ou esforço não grava nem remove credenciais. Substituir uma chave ou trocar OAuth por chave exige `replace: true`; omitir esse campo preserva a credencial existente e retorna erro. Uma falha no login também preserva a credencial anterior. Não há alteração em Compose, volumes ou caminhos de dados; as credenciais permanecem no banco privado existente, dentro do diretório de dados.

A integração Anthropic admite a chave armazenada ou `ANTHROPIC_API_KEY` provisionada pelo operador. Não usa `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` ou federação de identidade. Tokens que contêm `sk-ant-oat` são recusados porque o adaptador do Pi os reconhece como tokens de assinatura e muda a identidade da requisição. A aplicação não encaminha esses tokens pela API padrão.

## Contrato HTTP

Todos os endpoints abaixo exigem sessão web; mutações também exigem a origem configurada. Respostas usam `Cache-Control: no-store`.

- `GET /api/settings` retorna `mode`, `provider`, `modelId`, `effort`, `models` e `providers`, além da configuração MCP existente. `models` é o catálogo do provider padrão atual. Cada item de `providers` contém `id`, `name`, `authTypes`, `credentialType` e `models`. Cada modelo contém `provider`, `id`, `name` e `efforts`. `credentialType` é `oauth`, `api_key` ou `null`, e indica a credencial local armazenada; não valida acesso remoto nem representa credenciais de ambiente.
- `PUT /api/settings` aceita `{provider, modelId, effort}` como padrão para novas conversas. Omitir `provider` mantém o provider padrão atual.
- `PUT /api/conversations/:id/settings` aceita `{provider, modelId, effort}` para a conversa indicada. Omitir `provider` mantém o provider dessa conversa. Conversas e tarefas ativas bloqueiam essa alteração.
- `PUT /api/provider/:provider/api-key` aceita `{apiKey, replace?}`. Retorna somente `{provider, credentialType: "api_key"}`. Chaves vazias, com espaços/caracteres de controle, maiores que 16.000 caracteres ou tokens de assinatura Anthropic são recusados. A chave não aparece em status, catálogo ou resposta de erro.
- `POST /api/provider/login` preserva o login ChatGPT sem parâmetros. Também aceita `{provider: "openai", type: "oauth", replace?}`. Retorna `{id}`; `GET`, `POST` e `DELETE /api/provider/login/:id` mantêm o polling, as respostas a perguntas e o cancelamento vinculados à sessão que iniciou o fluxo. Chaves de API usam o endpoint próprio acima.
- `GET /api/status` usa o provider padrão atual e inclui metadados de providers, sem material secreto.

## Persistência e execução

O padrão completo fica em `model-defaults-selection:live` ou `model-defaults-selection:demo`. Instalações anteriores continuam lendo `model-defaults:<provider>` quando o novo registro ainda não existe. O provider e o modelo de cada conversa permanecem na configuração durável do Pi. Mudar o padrão ou alternar demo/live não reescreve conversas existentes. No modo demo, uma conversa live antiga pode precisar voltar ao modo live para executar; uma nova conversa demo usa o provider local.

Mensagens, compactações e tarefas agendadas resolvem a autenticação do provider da própria conversa. Tarefas existentes continuam vinculadas à conversa salva, inclusive após reinício. Há uma reserva síncrona entre alteração de credenciais e admissão de geração; a aplicação recusa mudanças durante entradas pendentes, execuções ou outro login. O cancelamento libera a reserva somente quando o fluxo nativo termina. Durante a reserva, o agendador não consome ocorrências vencidas; execuções já enfileiradas permanecem pendentes e são admitidas uma única vez depois, com o mesmo `requestId`. Leituras e alterações de credenciais por diferentes adaptadores do mesmo banco compartilham a fila de serialização, incluindo refresh OAuth.

`test/provider-api.test.ts` usa somente chaves falsas, respostas locais e transporte HTTP em loopback. Cobre resolução de autenticação e roteamento por conversa, agendamento após reinício, transporte nativo DeepSeek com respostas SSE locais, preservação de OAuth, substituição explícita, bloqueios concorrentes, variáveis de ambiente Anthropic, autorização HTTP e ausência de segredos em respostas.
