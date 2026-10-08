# Handoff web: evidência local e limites

Investigação em 8 de outubro de 2026, na branch `fix/web-handoff-interaction`, partindo de `f8a5614`. A validação usa Pi Durable, SDK MCP e provider faux em loopback, SQLite descartável e viewer fictício sem login. Não foram acessados tokens, credenciais, viewer ou conta reais.

## Defeito confirmado

Antes da alteração, clicar no link de viewer enviado pelo assistente substituiu a aba do Pi pela página mock. O renderer Markdown não definia `target` nem `rel`. Agora links HTTP(S) usam `_blank` e `noopener noreferrer`; esquemas executáveis e URLs com credenciais continuam bloqueados. No navegador integrado, clicar preservou a URL e a interface da aba do Pi. O teste automatizado verifica esses atributos. A abertura de uma segunda aba pelo host integrado não foi confirmada pelo inventário de abas.

Esse defeito de navegação não comprova a causa do relato de travamento de todos os cliques. O handoff simulado permaneceu utilizável: troca de conversa, abertura e fechamento de Tarefas/Configurações, menu móvel, Escape e cancelamento explícito funcionaram. A inspeção encontrou zero diálogos abertos e nenhum `inert` no desktop após fechar configurações; no móvel, Escape removeu `inert` do conteúdo principal e ocultou o backdrop. O código não aplica um bloqueio global ao aguardar uma interação MCP.

## Visibilidade de ferramentas

O novo controle mostra ou oculta chamadas e resultados comuns do histórico e do streaming. Guarda a preferência por navegador e continua funcionando sem armazenamento. Respostas do assistente, aprovações, interações MCP, erros e resultados que declaram pausa, espera ou incerteza não são ocultados. O renderer usa texto para os argumentos; não interpreta HTML da ferramenta.

Na prévia, a preferência ocultou a chamada, preservou o resultado pausado e os controles Aceitar/Recusar/Cancelar, e sobreviveu ao reload. O cancelamento explícito produziu os contadores mock `executions=1`, `resumes=1`, `paused=false`; antes dessa decisão, permaneciam `executions=1`, `resumes=0`, `paused=true`. O teste de backend também exige que uma nova execução seja recusada durante a pausa. Nenhuma permissão ou proteção de replay foi alterada.

Desktop 1280×720 e móvel 375×812 foram conferidos no navegador integrado, incluindo fechamento do diálogo no móvel, sem overflow horizontal. As capturas contêm apenas dados mock:

![Detalhes ocultos com aprovação disponível](evidence/web-handoff/hidden-tools-pending.jpg)

![Controle móvel e interação pendente](evidence/web-handoff/hidden-tools-mobile.jpg)

![Detalhes visíveis no tema escuro](evidence/web-handoff/tools-visible-dark-mobile.jpg)

## Verificação final

**155 testes passaram**, zero falhas e zero skips, em 33,53 segundos, no Node 26 local. `npm run check`, `npm run lint`, `npm run build`, Prettier nos arquivos de código alterados e `git diff --check` passaram. A suíte inclui teclado/composição IME, histórico/streaming, preferência e storage indisponível, renderer de links, módulo HTTP, retomada/reinício, efeitos incertos, decisões duplicadas e mocks MCP/Telegram. A aba e o processo mock foram encerrados, e o viewport foi restaurado.

## Beelink: tentativa inicial de coleta

Estado reportado às **17:12 UTC de 8 de outubro de 2026**. O alias SSH existente `Beelink` aponta para `forgez@beelink:22`. A tentativa inicial falhou na resolução do nome; com acesso de rede autorizado, a tentativa com verificação estrita retornou `No ED25519 host key is known for beelink` e `Host key verification failed`.

Nessa tentativa inicial, nenhum comando remoto foi executado e nenhuma chave nova foi aceita. Posteriormente, foi identificado o alias configurado `beelink`, em minúsculas, com identidade previamente confiada. A coleta de leitura pelo alias correto foi concluída e encaminhada ao projeto infra, que passou a cuidar desse diagnóstico. Este lote não altera configuração, permissões ou serviços do servidor. O travamento total permanece sem reprodução local.

## Publicação

No momento da validação local, as alterações estavam preparadas para revisão, sem publicação ou deploy. Docker não está disponível nesta máquina; a imagem deste lote não foi reconstruída localmente. A confirmação em produção depende da reprodução do incidente real. A publicação posterior usa o CI do repositório; o merge não constitui confirmação de que o travamento total foi corrigido.
