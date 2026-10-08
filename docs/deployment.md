# Implantação

O serviço é publicado como uma única instância Docker Compose, inclusive no Coolify. Use `APP_MODE=demo` para a instalação inicial. O modo `live` habilita o provedor OpenAI; o login da aplicação continua sendo protegido pela senha web. O modelo padrão é `gpt-6.1-sol`.

## Preparar

1. Instale Docker Engine com Docker Compose v2, ou conecte o repositório ao Coolify como serviço Docker Compose. Configure o diretório do arquivo Compose como raiz do projeto e a porta interna do serviço como `3000`.
2. No Docker local, copie `.env.example` para `.env`. No Coolify, informe as variáveis em **Environment Variables** após carregar o Compose do repositório. Defina `APP_ORIGIN` com a origem HTTPS pública exata, sem caminho, e mantenha `COOKIE_SECURE=true` atrás de TLS. Escolha `APP_MODE=demo` ou `APP_MODE=live`.
3. Defina `WEB_PASSWORD` com uma senha longa escolhida pelo operador (mínimo de 12 caracteres). No Coolify, habilite **Runtime / Available in the container** e desabilite **Build time / Available during build** para essa senha. Se o valor contiver `$`, configure **Interpolation / Literal**. O repositório não gera nem inclui credenciais; o `.env` está ignorado pelo Git. Veja a [documentação de variáveis do Coolify](https://coolify.io/docs/applications/configuration/environment-variables).
4. Inicie com `docker compose up -d --build`, ou execute o deploy no Coolify após salvar as variáveis. O build não exige a senha; o serviço recusa iniciar quando ela está vazia ou tem menos de 12 caracteres.

### Atualizar a configuração anterior no Coolify

Use a branch `main` e o arquivo `docker-compose.yml`. Recarregue a definição Compose do repositório para que `WEB_PASSWORD` apareça nas variáveis, informe seu valor em runtime e remova `WEB_PASSWORD_SECRET_FILE` se não usar a alternativa abaixo. Salve e faça um novo deploy. A definição padrão não exige arquivos de secrets no servidor nem no contêiner auxiliar de build.

### Alternativa com arquivos de secrets

Para um host onde os arquivos já estejam provisionados, use explicitamente `docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d --build`. Defina `WEB_PASSWORD_SECRET_FILE` como caminho absoluto do arquivo no host, legível pelo UID 1000 do contêiner. O override deixa `WEB_PASSWORD` vazio e define `WEB_PASSWORD_FILE`; o arquivo tem precedência. Em secrets baseados em arquivo, o Compose preserva as permissões de origem; não conte com `uid/gid/mode` para remapeá-las. Provisione o arquivo para o UID 1000, sem tornar credenciais legíveis para todos. Veja a [documentação de secrets do Compose](https://docs.docker.com/reference/compose-file/services/#secrets).

Essa alternativa precisa disponibilizar os arquivos em todo ambiente que executar os comandos Compose, inclusive qualquer contêiner auxiliar de deploy. Para o Coolify, a configuração padrão por variáveis evita essa dependência.

O Compose mantém as bases SQLite e as credenciais do provider dentro de `pi_agent_data`, montado em `/app/data`. O token Telegram conectado pela interface também fica no SQLite privado desse volume; os diretórios de dados usam modo `0700` e os arquivos SQLite, `0600`. O token nunca é devolvido pela API nem escrito nos logs. Esses modos limitam acesso no host e dentro do contêiner; não constituem uma nova promessa de criptografia. O volume deve persistir entre recriações do contêiner. Execute apenas uma réplica: a aplicação mantém estado local e não coordena gravações entre instâncias.

## Proxy e origem

Se os logs mostrarem `ERR_INVALID_URL` com o texto `Defina APP_ORIGIN como a origem HTTPS publica`, substitua o valor de `APP_ORIGIN` nas variáveis do Coolify pela URL pública real, por exemplo `https://pi.example.com`, sem barra final. Salve e refaça o deploy. Recarregar o Compose preserva valores existentes no Coolify, portanto a troca precisa ser feita na variável já cadastrada.

O contêiner escuta na porta `3000` apenas na rede Compose; encaminhe o domínio pelo proxy do Coolify ou por um proxy reverso que termine TLS. Defina `APP_ORIGIN` para a origem HTTPS que o usuário abre no navegador. Configure o proxy para preservar `Host` e `X-Forwarded-Proto`, encaminhar `text/event-stream` sem buffering nem compressão e permitir conexões SSE longas (timeout de leitura de pelo menos 10 minutos). Não exponha uma porta de host diretamente à internet.

## OpenAI, Telegram e MCP

`APP_MODE=live` habilita o provedor OpenAI. A autenticação do provedor ChatGPT é independente da senha web: conclua o OAuth interativamente na aplicação. Se o callback não puder ser aberto, use o prompt manual de URL de callback completa apresentado pela aplicação e conclua a troca no mesmo ambiente onde o serviço roda.

### Telegram

Conecte o Telegram pelo botão **Telegram** no cabeçalho da conversa, depois que o serviço estiver rodando. Selecione a conversa atual como destino e confira a prévia, informe o token do bot e seu próprio ID numérico de usuário (não o ID do bot), então escolha **Conectar**. A conexão é opcional: não configure token, allowlists, segredo de webhook nem URL pública para o Telegram no Compose. Campos de ambiente Telegram incompletos não impedem a inicialização do serviço web.

Ao conectar, a aplicação consulta `getMe` para validar e identificar o bot e `getWebhookInfo` para mostrar se há webhook configurado. Se não houver webhook, a conexão só é considerada pronta depois de uma consulta inicial bem-sucedida a `getUpdates` com timeout zero; em seguida, o poller usa long polling com timeout de 25 segundos e solicita apenas updates `message`. Se um webhook existente impedir o polling, **Conectar** não o apaga. A interface oferece uma ação separada para trocar para polling, mostra a origem sanitizada do webhook e a identidade esperada do bot; a confirmação verifica também um hash da URL completa e exige confirmação explícita antes de removê-lo. A aplicação não registra webhook nem abre uma rota pública para receber atualizações.

Depois de conectar, somente uma mensagem privada do usuário cujo ID foi informado pode iniciar o primeiro vínculo: a aplicação registra o chat privado e concede acesso à conversa escolhida no diálogo. Mensagens de outras pessoas e de grupos não ganham acesso por esse vínculo. Não há allowlist manual de chats nem código como etapa normal. Dados de vínculo existentes são preservados sem ampliar permissões; `/link CODIGO` e `/start CODIGO` continuam apenas como compatibilidade para pares explícitos antigos e orientação.

O token fica no SQLite privado em `pi_agent_data`, com diretório `0700` e arquivos `0600`. A API não o retorna e os logs não o incluem. **Desconectar** para o polling e mantém a conversa vinculada e o token armazenado. Uma identidade de bot diferente da já registrada fica bloqueada para evitar colisões de `update_id` e de grants; a interface apresenta estados `connecting`, `retrying` ou `blocked`, sem oferecer uma troca de bot.

Rode apenas um processo owner para o volume. Ele coordena um único poller. O lock impede uma segunda instância sobre o mesmo volume; um consumidor concorrente do mesmo bot provoca resposta 409 e estado `blocked` na interface. O offset durável só avança depois de admitir a mensagem ou rejeitá-la de forma terminal. Falhas transitórias de rede ou armazenamento mantêm a atualização pendente para nova tentativa. Recibos de duplicatas são preservados; uma entrega cujo resultado ficou incerto não é reenviada automaticamente.

As variáveis antigas `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN_FILE` (ou a configuração antiga `TELEGRAM_BOT_TOKEN_SECRET_FILE`), `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_ALLOWED_CHATS`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_SECRET_FILE` e `TELEGRAM_BOT_USERNAME` são somente dicas de migração. Não iniciam polling nem ativam vínculo por si mesmas. Um token de ambiente ou arquivo pode ser reutilizado somente quando o operador abre **Conectar**, deixa o campo de token vazio e confirma a ação. `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_ALLOWED_CHATS` e `TELEGRAM_WEBHOOK_SECRET` são obsoletas para a conexão nova. Vínculos e permissões anteriores permanecem restritos ao que já estava autorizado.

Veja a [API oficial do Telegram, incluindo `getUpdates`](https://core.telegram.org/bots/api#getupdates) para os requisitos de polling. O fluxo com contas reais não foi validado neste ambiente.

### Environment variables após esta atualização

Não há nova variável obrigatória. Para o Compose padrão no Coolify:

| Ação                                | Variáveis                                                                                                                              | Valor ou motivo                                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conferir/alterar                    | `APP_ORIGIN`                                                                                                                           | `https://pi.forgez.me`, sem caminho ou barra final.                                                                                                                                                 |
| Conferir/alterar                    | `APP_MODE`, `COOKIE_SECURE`                                                                                                            | `live` e `true` para a instalação HTTPS com ChatGPT.                                                                                                                                                |
| Manter                              | `WEB_PASSWORD`                                                                                                                         | A senha web existente, com pelo menos 12 caracteres; somente runtime, sem build-time. Não recrie a senha por causa deste lote.                                                                      |
| Manter                              | `MODEL_ID`                                                                                                                             | O modelo válido já escolhido; o padrão do Compose é `gpt-6.1-sol`. Configurações persistidas na UI têm precedência para novas conversas.                                                            |
| Manter se usado                     | `MCP_CONFIG_FILE`                                                                                                                      | Caminho do JSON montado somente leitura; se a conexão já é gerenciada pela UI, pode continuar vazio. O arquivo é lido no startup quando o caminho está definido, mesmo com configuração persistida. |
| Manter                              | `NODE_ENV`, `PORT`, `DATA_DIR`                                                                                                         | O Compose define `production`, `3000`, `/app/data`; preserve também o volume `pi_agent_data`.                                                                                                       |
| Remover da configuração nova        | `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_ALLOWED_CHATS`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_SECRET_FILE` | A nova conexão usa ID de usuário explícito na UI e polling; essas variáveis não ativam o bot.                                                                                                       |
| Remover após salvar a conexão na UI | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN_FILE`, `TELEGRAM_BOT_TOKEN_SECRET_FILE`                                                      | O token conectado passa a persistir no SQLite privado. O valor legado pode ser reutilizado uma vez por **Conectar** com o campo vazio; se removido antes, informe o token do mesmo bot na UI.       |
| Remover somente no Compose padrão   | `WEB_PASSWORD_SECRET_FILE`, `WEB_PASSWORD_FILE`                                                                                        | Não são necessários com `WEB_PASSWORD`. Se usar o override de secrets provisionados, mantenha-os conforme a alternativa descrita acima.                                                             |

Após o redeploy, abra a conversa de destino e o botão **Telegram**, informe seu ID numérico de usuário e conecte o mesmo bot. Retirar variáveis antigas não migra a conexão, não apaga um webhook e não elimina os vínculos anteriores. Se existir webhook, confira o bot e a origem exibidos e confirme **Trocar para polling** somente quando quiser interromper a entrega ao endereço anterior. A aplicação verifica o hash da URL completa e preserva updates pendentes; uma remoção com resultado incerto exige verificação antes de uma nova tentativa explícita. Abra o bot e envie uma mensagem privada do ID autorizado para completar o vínculo do chat.

Depois de salva, a conexão habilitada retoma no reinício com o token e offset do volume; **Desconectar** mantém esses dados, mas exige uma nova ação **Conectar** para retomar. O login ChatGPT, histórico, configurações MCP e agendas também permanecem no volume existente.

A correção de sessão MCP não exige migrar modo, trocar token nem ampliar ferramentas permitidas. Configurações salvas na UI continuam tendo precedência sobre o catálogo do arquivo após o startup; o modo `legacy` continua `legacy`. Use **Atualizar ferramentas** para conferir o catálogo. Uma chamada antiga já marcada incerta não é transformada em sucesso: verifique o resultado no serviço antes de usar **Registrar resultado**. A migração opcional para chamadas diretas continua exigindo confirmação explícita e uma revisão das permissões.

MCP também é opcional e aceita endpoints HTTPS via Streamable HTTP; HTTP só é aceito em loopback para testes locais. Revise `mcp.json`, monte-o em `/app/config/mcp.json` como somente leitura e defina `MCP_CONFIG_FILE=/app/config/mcp.json`. Não monte sockets, diretórios amplos ou credenciais administrativas.

## Dados e manutenção

Proteja o host e o volume com criptografia de disco. Faça backups regulares offline do SQLite e dos demais arquivos de `/app/data`; teste a restauração antes de depender deles. Guarde cópias fora do servidor e restrinja o acesso aos backups. Para atualizar, obtenha a nova versão e execute `docker compose up -d --build`; mantenha o mesmo volume persistente.

O contêiner roda como usuário `node`, com sistema de arquivos raiz somente leitura, `/tmp` temporário, capacidades Linux removidas e `no-new-privileges`. A verificação de saúde consulta `/healthz` na porta interna `3000`.
