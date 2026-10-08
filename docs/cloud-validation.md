# Validação cloud: renderer e destino das tarefas

Validação local em 8 de outubro de 2026, Node 24.19.0 e Chromium do ambiente cloud. Branch `cloud/validate-safari-cron`, base comum `83a2a475c7c905ff4e88089b1447f5ad7b35ceec`. As branches originais foram preservadas; não houve push, merge ou deploy.

## Commits recebidos

Os SHAs remotos foram conferidos antes do cherry-pick, nesta ordem:

| Origem | SHA recebido | Commit na branch cloud |
| --- | --- | --- |
| Entrega cron autorizada | `007f62e0ab4e8c0187cf9d1e9965ac960d78747c` | `800b182` |
| Seletor de destino | `1974f434644ac5240587965feed6016ea5a9f78b` | `565f752` |
| Limites do renderer | `9558e6b5378f77249e82e30f3eff1e5c95896bcd` | `9e995d8` |

A aplicação foi sem conflitos. A base cron e o seletor continuam commits separados da mudança do renderer.

## Revisão e correções adicionais

A revisão independente da UI, realizada por Luna com esforço xhigh conforme a preferência do usuário, identificou duas mensagens incorretas: o formulário voltava para Web após criar uma tarefa, mas mantinha o aviso de cópia Telegram; uma resposta atrasada sobre a conversa anterior também podia sobrescrever o aviso da conversa atual. A geração por seletor agora descarta respostas antigas e o reset atualiza o aviso. As duas regressões falharam antes da correção e passaram depois em `test/task-delivery-ui.test.ts`.

A revisão do fluxo durável identificou que `tasks_set_delivery`, declarado replay-safe, não tinha recibo para o efeito local. Repetir uma alteração antiga depois de uma escolha posterior voltava o destino ao valor antigo. A alteração e seu recibo agora são gravados na mesma transação; replays retornam o resultado registrado sem reaplicar o efeito. O teste reproduziu a sobrescrita antes e verifica persistência, conflito de chave e rollback de falha de gravação depois. O teste com o provider faux também verifica que o tool real grava o recibo.

O destino `legacy` continua preservado para agendas migradas. Novas agendas oferecem somente Web e Web+Telegram: não podem usar o modo de compatibilidade para contornar a exigência de vínculo na seleção de Telegram. Mudar apenas o destino preserva cron, fuso, estado de pausa e próxima execução.

No navegador, os controles de paginação eram recriados em cada snapshot. O estresse detectou um controle destacado do DOM durante a interação. A navegação agora mantém seus nós, atualiza rótulo e estados dos botões, e seus handlers consultam a página atual. O harness verifica a identidade da navegação e dos registros estáticos durante SSE e a identidade da navegação entre páginas.

Essas correções foram registradas separadamente: `d636e9b` (destino) e `6ad7a38` (navegação).

## Fixture exato e estresse

Foi usado o fixture transferido `test/fixtures/render-stress.ts`, sem alterar seu conteúdo: **1.600 entradas, snapshot inicial de 5.532.358 bytes**, resultado sintético com 4 MiB de base64 repetitivo e pulso live de 750 ms. O servidor usa SQLite temporário, provider demo e gateway que recusa ferramentas externas.

O parser da base `83a2a47`, com o texto exato do resultado do fixture (4.194.378 caracteres), lançou `RangeError: Maximum call stack size exceeded` em 145 ms. O renderer corrigido produziu uma prévia de 32.768 caracteres em aproximadamente 1 ms. Na página Chromium da base, o erro foi capturado pelo handler da aplicação, apareceu em `login-error` e o histórico ficou com zero mensagens; não houve evento `pageerror` nesse caminho tratado.

Na página corrigida, cada viewport visitou as 20 páginas do histórico, conferiu as 800 respostas de assistente sem perda, baixou e analisou o resultado integral de 4.194.378 bytes, expandiu/recolheu o detalhe grande e verificou liberação do corpo lazy, alternou Ferramentas, abriu/fechou Configurações e Tarefas, rolou repetidamente e trocou entre a conversa extensa e a vazia. O limite foi de 80 registros históricos mais uma mensagem live, com 2.629 nós DOM na janela medida.

| Chromium | Snapshots observados | Mensagens no DOM | Maior atraso amostrado do timer | Erros de página / overflow horizontal |
| --- | ---: | ---: | ---: | --- |
| 1280 × 900 | 32 | 81 | 178 ms | nenhum |
| 390 × 844 | 35 | 81 | 79 ms | nenhum |
| 812 × 375 | 43 | 81 | 101 ms | nenhum |

O atraso é uma medida de timer de 100 ms no ambiente compartilhado, incluindo carregamento/interações; não é uma garantia de latência de cliques ou uma medição de Safari. Nessa rodada houve execução de testes em paralelo.

## Destinos na UI e transporte mock

No Chromium 1280 × 900 e 390 × 844, o formulário abriu em Web, criou tarefas Web e Web+Telegram, corrigiu o aviso ao voltar para Web e rejeitou a criação Telegram para uma conversa sem vínculo. A edição de uma agenda existente mudou apenas `delivery`. Novas tarefas tiveram duas opções no editor e a API rejeitou a tentativa de selecionar `legacy` nelas.

Cada viewport executou manualmente uma tarefa de cada destino contra o provider demo. Web não gerou envio; Web+Telegram gerou uma única cópia pelo transporte mock. Repetir a mesma chave de execução, inclusive depois da conclusão, manteve uma ocorrência e uma cópia. Nenhuma chamada à API real do Telegram foi feita.

A suíte de entrega cobre autorização pelo vínculo/grant/configuração/bot/allowlists atuais, deduplicação e restart, revogação terminal das partes pendentes, troca de conversa, histórico com mais de mil entradas, falhas de admissão/settlement, rollback, mensagens longas e estados incertos sem replay. Resultados completos permanecem na conversa web e permissões de ferramentas continuam aplicáveis às tarefas.

## Verificações finais

- Tipos, lint, build e `git diff --check`: passaram após as correções.
- Suíte final: **190 testes passaram**, zero falhas, cancelamentos ou skips, em **67,36 segundos**. Resultado registrado no log `/workspace/scratch/pi-final-tests.log`.
- Smoke com build compilado e execução TypeScript em demo: passou autenticação/Origin, resposta demo, deduplicação e persistência SQLite após reinício.
- Logs, JSONs, capturas e harnesses de navegador ficam em `/workspace/scratch` neste ambiente; os fixtures do projeto permanecem em `test/fixtures`.

## Limites e pendências

WebKit não está instalado, e seus downloads foram recusados com HTTP 403. **Safari real/iOS não foi validado**. A reprodução em Node/Chromium confirma a falha do parser com o fixture e a proteção do renderer; ainda é necessário repetir os cenários no Safari e confirmar o problema relatado pelo usuário antes de afirmar que seu incidente foi resolvido.

A paginação limita o DOM; o protocolo ainda transporta snapshots completos quando o estado muda, portanto custo de rede/JSON continua proporcional ao histórico. A retenção de páginas antigas durante entrada de novas mensagens e volumes maiores podem exigir avaliação adicional. Envio já iniciado antes de revogação pode ter chegado; partes incertas não são reenviadas automaticamente.

Docker não foi reconstruído nesta rodada. Contas, credenciais, providers, MCPs e Telegram reais não foram usados. Publicação da branch, merge em main e deploy continuam pendentes de aprovação final.
