# Claude: API nesta rodada e compatibilidade futura com CLI

Investigação em 9 de outubro de 2026. A rodada atual implementa chaves de API OpenAI, API padrão Anthropic e DeepSeek pelos providers nativos do Pi, preservando o login ChatGPT existente. Nenhuma conta real foi conectada e nenhuma chamada paga foi usada para validar a implementação.

## API padrão

O pacote instalado `@earendil-works/pi-ai@1.0.4` inclui `anthropicProvider`, catálogo Claude e transporte baseado no SDK Anthropic. Sua versão original também oferece OAuth de assinatura e aceita tokens antigos como fonte ambiente. A aplicação deve registrar somente o método de API padrão, sem ativar essa alternativa OAuth nem aceitar um token de assinatura no campo de chave. O SDK identifica `sk-ant-oat` como OAuth e muda os headers; essa fronteira exige teste próprio.

A API padrão usa credenciais do Console e o transporte oficial; não depende de reproduzir login claude.ai. Salvar uma chave é uma operação local, sem geração ou consulta paga automática. Catálogo local não prova validade da chave, disponibilidade do modelo ou saldo da conta. [Documentação da API Anthropic](https://platform.claude.com/docs/en/api/overview).

As credenciais continuam no Store SQLite do servidor e no mesmo volume persistente, sem retorno em respostas ou URLs e sem armazenamento no navegador. Esse padrão existente não fornece criptografia adicional em repouso: permissões do diretório/processo/volume e seus backups precisam continuar protegidos. A autenticação atual permanece até uma ação explícita de substituição; uma seleção de provedor/modelo não substitui credenciais. O provedor de conversas existentes deve sobreviver à troca do padrão e ao reinício.

## O que mudou na documentação de assinatura

O suporte oficial atualizado em 7 de outubro informa que Agent SDK, `claude -p` e apps terceiros ainda podem consumir os limites de assinatura; as mudanças anunciadas foram pausadas em junho. Também informa créditos API mensais para Max e Team. Isso impede tratar assinatura como inviável ou necessariamente limitada a extra usage. Não equivale a fornecer uma chave de API irrestrita para qualquer app. [Atualização oficial dos planos](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

A documentação distingue o usuário entrando no binário Claude Code oficial e não modificado, inclusive quando hospedado, de um app oferecendo seu próprio login claude.ai, intermediando tokens ou roteando credenciais de assinatura em nome dos usuários. O primeiro caminho pode ser avaliado; o segundo não é a arquitetura proposta. A documentação não certifica o relay específico do Hermes. [Autenticação e uso de credenciais](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

## Referência Hermes

O plugin `hermes-plugin-claude-subscription-directsdk` é experimental e depende da infraestrutura external-process do Hermes >=0.21.4, incorporada pelo PR #117451, commit `118984d7a02f8a8baec11255002cbbab7c202e06`. O PR original #105863 foi fechado sem merge. Apesar do nome, usa o CLI oficial como subprocesso e stream-json, mantendo loop, ferramentas, aprovações e histórico no host. [Plugin oficial](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk), [catálogo](https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/claude-subscription-directsdk.yaml).

O transporte cria um processo por requisição, desativa ferramentas nativas, oferece MCP inerte, usa `dontAsk`, traduz histórico/resultados e conserva thinking assinado. Um relay HTTP local limita a primeira requisição de geração: `--max-turns 1` sozinho não forneceu essa garantia. Cancelamento encerra a árvore de processos e a conexão; retomada e compactação exigem fidelidade ao histórico durável. Isso é um provider novo, não uma troca de URL/token. [Transporte e ciclo de vida](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk/blob/main/directsdk.py).

Há uma diferença entre a descrição do README e o código auxiliar: `_subscription_token()` lê token de ambiente ou credenciais do Claude Code para consultar `/api/oauth/usage`. Esse comportamento não será copiado. Estado/limites de uma futura integração deverão vir de interfaces oficialmente expostas pelo CLI, sem abrir arquivos de credenciais ou renovar tokens no app. [Código de uso da conta](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk/blob/main/__init__.py).

## Referência futura, fora do escopo

O usuário escolheu manter esta rodada simples, usando os providers nativos de API. A pesquisa de assinatura fica como referência: não há implementação planejada de relay Hermes, subprocesso Claude Code ou login OAuth próprio Claude nesta entrega.

Uma eventual avaliação futura precisaria demonstrar fidelidade do histórico/tools, cancelamento e compatibilidade com o CLI oficial. `--bare` não serve para esse caminho: ignora o login OAuth e exige credencial de API/cloud. [Modo bare oficial](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode).

Compose/Coolify e o volume existente não precisam ser modificados para a opção configurada na interface. Variáveis ambientais opcionais e a validação com mocks estão documentadas em [provider-api.md](provider-api.md).
