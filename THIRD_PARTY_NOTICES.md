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
