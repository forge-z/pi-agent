# Avisos de terceiros

Este projeto usa ou se inspira nos seguintes trabalhos. Os arquivos de licença indicados estão incluídos no repositório; pacotes npm também trazem seus próprios avisos em `node_modules` após `npm ci`.

| Componente                   | Versão / uso                                                               | Licença e origem                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `@earendil-works/pi-durable` | 1.0.4; runtime e persistência de conversas                                 | MIT; projeto [Pi](https://github.com/earendil-works/pi), texto em [vendor/pi-LICENSE](vendor/pi-LICENSE).                         |
| `@earendil-works/pi-ai`      | 1.0.4; modelos, providers e login OAuth                                    | MIT; projeto [Pi](https://github.com/earendil-works/pi), texto em [vendor/pi-LICENSE](vendor/pi-LICENSE).                         |
| `@earendil-works/chord`      | 1.0.4; contexto do runtime                                                 | MIT; projeto [Pi](https://github.com/earendil-works/pi), texto em [vendor/pi-LICENSE](vendor/pi-LICENSE).                         |
| `@modelcontextprotocol/sdk`  | 1.32.1 no lockfile; cliente MCP Streamable HTTP                            | MIT; o pacote instalado inclui seu aviso de licença.                                                                              |
| `proper-lockfile`            | 4.1.2 no lockfile; exclusão de owner do diretório de dados                 | MIT; o pacote instalado inclui seu aviso de licença.                                                                              |
| Pi Pocket                    | Referência de lifecycle do service worker e interação de login do provider | MIT; projeto [pi-pocket](https://github.com/TannerMidd/pi-pocket), texto em [vendor/pi-pocket-LICENSE](vendor/pi-pocket-LICENSE). |

O lifecycle de instalação/ativação do service worker e a ponte de interação de login foram adaptados como referências do Pi Pocket. O projeto Pi iMessage serviu como referência de desenho para transporte, fila, allowlist e entrega conservadora; nenhum código-fonte desse projeto foi copiado.

Os demais pacotes runtime e de desenvolvimento, inclusive versões transitivas, estão registrados em [package-lock.json](package-lock.json). Consulte os metadados e avisos de cada pacote instalado para seus termos aplicáveis.

## Identidade e recursos visuais

- **Logo e favicon oficiais do Pi:** baixados sem alterar seus paths ou cores de [pi.dev/logo-auto.svg](https://pi.dev/logo-auto.svg) e [pi.dev/favicon.svg](https://pi.dev/favicon.svg), recursos publicados no [press kit oficial](https://pi.dev/press-kit). O site oficial informa licença MIT. A marca pertence ao projeto Pi; seu uso identifica a base tecnológica e não implica endosso desta aplicação.
- **Phosphor Icons 2.1.1:** subconjunto de SVGs do pacote oficial `@phosphor-icons/core`, incorporado a `public/icons.svg`. Licença MIT de Phosphor Icons; texto integral em [vendor/Phosphor-MIT.txt](vendor/Phosphor-MIT.txt). Origem: [phosphor-icons/phosphor-core](https://github.com/phosphor-icons/phosphor-core).
- **DM Sans e Instrument Serif:** arquivos originais do Google Fonts, hospedados localmente em `public/fonts/`. Licença SIL Open Font License 1.1; textos integrais em [vendor/DM-Sans-OFL.txt](vendor/DM-Sans-OFL.txt) e [vendor/Instrument-Serif-OFL.txt](vendor/Instrument-Serif-OFL.txt). Origens: [DM Sans](https://github.com/google/fonts/tree/main/ofl/dmsans) e [Instrument Serif](https://github.com/google/fonts/tree/main/ofl/instrumentserif).
- **Refero Styles:** referências de direção visual de Cursor e Perplexity, detalhadas em [docs/design.md](docs/design.md). Nenhum código-fonte ou imagem desses produtos foi incorporado.
