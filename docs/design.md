# Direção visual do Pi

A interface combina composição editorial e títulos serifados com três temas: Azul, Cinza e Pi. Azul é o padrão, com superfícies claras azuladas, azul-marinho no escuro e destaques azuis. Cinza oferece as mesmas telas em uma escala neutra. Pi segue a direção visual do site oficial, com papel quente no claro, azul profundo no escuro, bordas retas e grade discreta. A área de conversa tem prioridade, com navegação discreta, campo de mensagem amplo e detalhes técnicos recolhíveis nas aprovações.

## Referências

Consultadas em 7 de outubro de 2026:

- [Cursor no Refero](https://styles.refero.design/style/4e3b4717-84c8-4599-baaf-a343c3d619b6): superfícies quentes e hierarquia tipográfica leve.
- [Perplexity no Refero](https://styles.refero.design/style/81afaa5c-73ac-4ef4-9a99-296da325ea6c): conversa central, compositor em destaque e sugestões discretas.
- [Press kit oficial do Pi](https://pi.dev/press-kit): logo e favicon originais, preservados como SVGs locais.
- [Phosphor Icons](https://phosphoricons.com): ícones regulares, sem emojis. Apenas os 26 SVGs usados ou reservados para estados da interface foram incorporados ao sprite local.

A composição e os componentes foram implementados para este projeto, sem copiar código das interfaces de referência.

## Aparência

**Paleta** (Azul, Cinza ou Pi) e **Aparência** (Claro, Escuro ou Automático) são seletores independentes. Ambos aparecem na entrada e na navegação, e suas escolhas são persistidas separadamente. Adicionar Pi não altera as preferências existentes nem o padrão Azul.

O padrão é **Automático**, que acompanha `prefers-color-scheme`, inclusive quando o sistema muda enquanto a página está aberta. **Claro**, **Escuro** e **Automático** ficam disponíveis na entrada e no rodapé da navegação. A preferência é salva apenas no navegador, sincroniza entre abas e funciona em memória se o armazenamento local estiver indisponível. A inicialização do tema ocorre antes do CSS para evitar um flash do tema incorreto.

| Paleta Azul      | Claro     | Escuro    |
| ---------------- | --------- | --------- |
| Fundo            | `#f5f8fc` | `#141e30` |
| Navegação        | `#eaf0f8` | `#101827` |
| Superfície       | `#ffffff` | `#1b2940` |
| Texto            | `#1f304d` | `#e7edf8` |
| Texto secundário | `#5b6b83` | `#9caccc` |
| Acento           | `#315db9` | `#95b6ff` |
| Ação principal   | `#315db9` | `#a9c4ff` |

Na paleta Cinza, os fundos são `#f7f7f7` / `#202020`, a navegação `#eeeeee` / `#181818` e as ações principais `#353535` / `#dedede`. O logo oficial mantém suas cores em ambas as paletas. Estados de erro preservam o contraste sem depender só da cor.

DM Sans atende os controles e o texto de conversa; Instrument Serif dá personalidade à entrada e à primeira conversa. As fontes são servidas pelo próprio aplicativo, com suas licenças SIL OFL em `vendor/`. Os SVGs do Pi mantêm as cores oficiais.

O tema Pi usa os tokens de cor do [CSS oficial](https://pi.dev/style.css), consultado em 8 de outubro de 2026, com contraste adaptado às superfícies desta aplicação. Os fundos são `#ebe7e4` / `#161d27`, as superfícies `#f3f2f0` / `#212730`, e os destaques `#4b607c` / `#6a9fcc`. Títulos usam Georgia; botões e rótulos usam fontes monoespaçadas do sistema. O texto da conversa mantém DM Sans. A fonte comercial Plantin do site não foi incorporada. A grade é feita em CSS, sem imagens, animações ou dependências adicionais.

## Interação e acessibilidade

- A busca filtra os títulos das conversas existentes; sugestões preenchem a mensagem e aguardam o envio.
- Enter ou `⌘+Enter` envia; `Ctrl+Enter` insere uma nova linha na posição do cursor.
- Em telas pequenas, a navegação vira um painel com foco contido, fechamento por Escape e fundo inerte. Seus controles continuam acessíveis em telas baixas por rolagem.
- Botões de ícone têm nomes acessíveis; ícones decorativos não são anunciados. Os temas usam `aria-pressed` e os diálogos são nativos.
- O estado das ações aparece em português e por texto, além das cores. Dados da proposta, contexto lido e resultado continuam disponíveis para revisão.
- As animações são breves e respeitam `prefers-reduced-motion`. Nenhum conteúdo de usuário é injetado como HTML.
- Aparência, paleta e visibilidade dos detalhes de ferramentas usam localStorage; mensagens pendentes mantêm a deduplicação existente por requestId.
- **Ferramentas** é um botão com estado pressionado e ícone Phosphor de plugue. Ocultar detalhes preserva respostas, aprovações, erros e resultados pendentes. Links HTTP(S) das respostas preservam a aba da conversa.
