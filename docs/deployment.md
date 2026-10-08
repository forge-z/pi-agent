# Implantação

O serviço é publicado como uma única instância Docker Compose, inclusive no Coolify. Use `APP_MODE=demo` para a instalação inicial. O modo `live` habilita o provedor OpenAI; o login da aplicação continua sendo protegido pela senha web. O modelo padrão é `gpt-6.1-sol`.

## Preparar

1. Instale Docker Engine com Docker Compose v2, ou conecte o repositório ao Coolify como serviço Docker Compose. Configure o diretório do arquivo Compose como raiz do projeto e a porta interna do serviço como `3000`.
2. No Docker local, copie `.env.example` para `.env`. No Coolify, informe as variáveis em **Environment Variables** após carregar o Compose do repositório. Defina `APP_ORIGIN` com a origem HTTPS pública exata, sem caminho, e mantenha `COOKIE_SECURE=true` atrás de TLS. Escolha `APP_MODE=demo` ou `APP_MODE=live`.
3. Defina `WEB_PASSWORD` com uma senha longa escolhida pelo operador (mínimo de 12 caracteres). No Coolify, habilite **Runtime / Available in the container** e desabilite **Build time / Available during build** para essa senha e para os segredos Telegram. Se o valor contiver `$`, configure **Interpolation / Literal**. O repositório não gera nem inclui credenciais; o `.env` está ignorado pelo Git. Veja a [documentação de variáveis do Coolify](https://coolify.io/docs/applications/configuration/environment-variables).
4. Inicie com `docker compose up -d --build`, ou execute o deploy no Coolify após salvar as variáveis. O build não exige a senha; o serviço recusa iniciar quando ela está vazia ou tem menos de 12 caracteres.

### Atualizar a configuração anterior no Coolify

Use a branch `main` e o arquivo `docker-compose.yml`. Recarregue a definição Compose do repositório para que `WEB_PASSWORD` apareça nas variáveis, informe seu valor em runtime e remova `WEB_PASSWORD_SECRET_FILE` se não usar a alternativa abaixo. Salve e faça um novo deploy. A definição padrão não exige arquivos de secrets no servidor nem no contêiner auxiliar de build.

### Alternativa com arquivos de secrets

Para um host onde os arquivos já estejam provisionados, use explicitamente `docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d --build`. Defina `WEB_PASSWORD_SECRET_FILE` como caminho absoluto do arquivo no host, legível pelo UID 1000 do contêiner. O override deixa `WEB_PASSWORD` vazio e define `WEB_PASSWORD_FILE`; o arquivo tem precedência. Em secrets baseados em arquivo, o Compose preserva as permissões de origem; não conte com `uid/gid/mode` para remapeá-las. Provisione o arquivo para o UID 1000, sem tornar credenciais legíveis para todos. Veja a [documentação de secrets do Compose](https://docs.docker.com/reference/compose-file/services/#secrets).

Essa alternativa precisa disponibilizar os arquivos em todo ambiente que executar os comandos Compose, inclusive qualquer contêiner auxiliar de deploy. Para o Coolify, a configuração padrão por variáveis evita essa dependência.

O Compose mantém as bases SQLite e as credenciais do provider dentro de app.sqlite em `pi_agent_data`, montado em `/app/data`. O volume deve persistir entre recriações do contêiner. Execute apenas uma réplica: a aplicação mantém estado local e não coordena gravações entre instâncias.

## Proxy e origem

Se os logs mostrarem `ERR_INVALID_URL` com o texto `Defina APP_ORIGIN como a origem HTTPS publica`, substitua o valor de `APP_ORIGIN` nas variáveis do Coolify pela URL pública real, por exemplo `https://pi.example.com`, sem barra final. Salve e refaça o deploy. Recarregar o Compose preserva valores existentes no Coolify, portanto a troca precisa ser feita na variável já cadastrada.

O contêiner escuta na porta `3000` apenas na rede Compose; encaminhe o domínio pelo proxy do Coolify ou por um proxy reverso que termine TLS. Defina `APP_ORIGIN` para a origem HTTPS que o usuário abre no navegador. Configure o proxy para preservar `Host` e `X-Forwarded-Proto`, encaminhar `text/event-stream` sem buffering nem compressão e permitir conexões SSE longas (timeout de leitura de pelo menos 10 minutos). Não exponha uma porta de host diretamente à internet.

## OpenAI, Telegram e MCP

`APP_MODE=live` habilita o provedor OpenAI. A autenticação do provedor ChatGPT é independente da senha web: conclua o OAuth interativamente na aplicação. Se o callback não puder ser aberto, use o prompt manual de URL de callback completa apresentado pela aplicação e conclua a troca no mesmo ambiente onde o serviço roda.

Telegram é opcional. Informe `TELEGRAM_BOT_TOKEN` e `TELEGRAM_WEBHOOK_SECRET` como variáveis de runtime, além de `TELEGRAM_ALLOWED_USERS` e `TELEGRAM_ALLOWED_CHATS` como listas separadas por vírgula, limitadas aos IDs autorizados. Sem token, o transporte fica desabilitado. Para a alternativa por arquivos, configure `TELEGRAM_BOT_TOKEN_SECRET_FILE` e `TELEGRAM_WEBHOOK_SECRET_FILE` e descomente os blocos correspondentes em `docker-compose.secrets.yml`.

Opcionalmente, defina `TELEGRAM_BOT_USERNAME` com o username público do seu bot, sem `@`. Isso habilita o botão de abertura do bot com código (`/start CODIGO`) e aceita sufixos `@USERNAME` apenas para esse bot. Sem username, copie `/link CODIGO` e envie diretamente ao bot no Telegram. O comando não deve ser enviado ao chat web do Pi. `/start` sozinho apenas orienta e não relaxa as allowlists nem cria vínculo.

MCP também é opcional e aceita endpoints HTTPS via Streamable HTTP; HTTP só é aceito em loopback para testes locais. Revise `mcp.json`, monte-o em `/app/config/mcp.json` como somente leitura e defina `MCP_CONFIG_FILE=/app/config/mcp.json`. Não monte sockets, diretórios amplos ou credenciais administrativas.

## Dados e manutenção

Proteja o host e o volume com criptografia de disco. Faça backups regulares offline do SQLite e dos demais arquivos de `/app/data`; teste a restauração antes de depender deles. Guarde cópias fora do servidor e restrinja o acesso aos backups. Para atualizar, obtenha a nova versão e execute `docker compose up -d --build`; mantenha o mesmo volume persistente.

O contêiner roda como usuário `node`, com sistema de arquivos raiz somente leitura, `/tmp` temporário, capacidades Linux removidas e `no-new-privileges`. A verificação de saúde consulta `/healthz` na porta interna `3000`.
