# Investigação local de bloqueio da interface e envio

Validação cloud em 9 de outubro de 2026, baseada em `2ef025b`. O PR draft #15
continua separado desta correção. Nenhum merge, deploy, serviço real, credencial
real ou chamada paga foi usado. Os dados de teste são sintéticos.

## Falha reproduzida

O limite anterior de 32.768 caracteres evitava o stack overflow com grandes
blocos de base64. Porém, o limite de 1.500 objetos era verificado **depois** de
`lexer(text)`. Markdown denso ou incompleto podia bloquear essa chamada antes da
proteção funcionar.

No Node 24.19, `"**a ".repeat(n)` levou 757 ms com 8.192 caracteres, 2.880 ms
com 16.384 e 6.550 ms com 24.576. A execução com 32.760 caracteres foi
interrompida após 11 segundos. São amostras locais, não limites garantidos.

Um teste com a aplicação e seu SSE real, SQLite temporário, gateway bloqueado e
Chromium headless recebeu o texto sintético e enfileirou o envio de uma mensagem.
Antes da correção, o renderer ocupou a thread por 10.953 ms e o POST começou
10.958 ms após o envio ter sido enfileirado. Depois que chegou ao servidor, a
admissão levou 8 ms e o ACK chegou em 21 ms. Isso demonstra uma causa de atraso
**antes** da resposta do modelo; não é uma medição do incidente em produção.

A primeira correção, limitada aos delimitadores de ênfase, reduziu o mesmo
cenário para 20 ms até o POST e mais 14 ms até o ACK. A revisão independente
encontrou outro caso lento: listas com `-`, `+` e `.`. A versão final conta toda
a pontuação ASCII antes do parser e usa texto simples quando ultrapassa 256
caracteres de pontuação. O conteúdo permanece completo; textos acima do limite
de prévia continuam disponíveis pelo download existente. Prosa Unicode comum
não é classificada como pontuação ASCII.

O teste final do navegador, executado enquanto outros checks e testes de
estresse estavam ativos, mediu 78 ms até o POST e mais 72 ms até o ACK, sem
exceções. O corpus independente de 193 casos passou com a política final;
a maior amostra foi 18,5 ms. A política é uma proteção conservadora de
complexidade, não um prazo rígido de CPU para qualquer entrada possível.

## Conteúdo grande e retenção

O fixture de 1.600 entradas e snapshot de aproximadamente 5,53 MB passou nos
viewports 1280×900, 390×844 e 812×375. Cada execução visitou todas as vinte
páginas, conferiu 800 respostas distintas, expandiu/recolheu ferramentas,
baixou o conteúdo completo de 4.194.378 bytes, rolou, abriu configurações e
tarefas e trocou de conversa. Houve 32, 44 e 42 snapshots, respectivamente;
80 mensagens históricas mais uma live, sem erros de página ou overflow
horizontal. Os maiores atrasos amostrados de timer foram 94, 280 e 144 ms.

Um snapshot isolado de 32 MB provocou tarefas longas de 100 e 117 ms e atraso
máximo de timer de 206 ms no Chromium, sem crash. Uma revisão independente
com quatro snapshots sucessivos de imagem de 8 MB e coleta forçada verificou
que os objetos antigos eram liberados; o heap voltou de cerca de 11 MB para
2,64 MB ao trocar para um snapshot pequeno. Isso não comprova o comportamento
do coletor de memória do Safari.

Em uma carga maior, a mesma conversa recebeu quarenta snapshots de cerca de
35 MB, cada um incluindo um resultado sintético de 32 MB, ao longo de cerca de
29 segundos. O Chromium não apresentou erros ou crash, mas o heap amostrado
chegou a 269 MiB, o maior atraso de timer foi 431 ms e a operação de clicar em
Enviar e aguardar o ACK levou 203 ms. O teste demonstra pressão de memória e
trabalho periódico relevante; não demonstra um vazamento ou identifica o
limite de memória do Safari. Otimizar o transporte completo permanece uma
possível etapa separada, especialmente se a conversa real tiver muitos
resultados de screenshots.

## Limites

A tela branca relatada pelo usuário **não foi reproduzida**. Safari real e
iOS não foram validados; o teste no Mac não produziu dados de console, DOM ou
rede. O protocolo ainda transporta snapshots completos, com custo proporcional
ao histórico, mesmo que o DOM mostre uma página limitada. Não foi introduzida
uma mudança de protocolo ou eliminação de conteúdo sem evidência de que isso
resolveria o incidente. A correção trata os bloqueios do parser demonstrados
pelos testes, sem afirmar que elimina toda causa de atraso ou tela branca.

Para validar no Safari, repetir a conversa afetada, o retorno do viewer, a
rolagem e o envio; distinguir tempo até o POST, duração até o ACK e tempo até a
primeira resposta. Qualquer coleta deve registrar somente tempos, tamanhos e
categorias de erro, sem texto de mensagens, cookies, tokens ou URLs do viewer.
