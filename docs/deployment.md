# Implantação

O serviço é publicado como uma única instância Docker Compose, inclusive no Coolify. Use `APP_MODE=demo` para a instalação inicial. O modo `live` habilita o provedor OpenAI; o login da aplicação continua sendo protegido pela senha web. O modelo padrão é `gpt-6.1-sol`.

## Preparar

1. Instale Docker Engine com Docker Compose v2, ou conecte o repositório ao Coolify como serviço Docker Compose. Configure o diretório do arquivo Compose como raiz do projeto e a porta interna do serviço como `3000`.
2. Copie `.env.example` para `.env`. Defina `APP_ORIGIN` com a origem HTTPS pública exata, sem caminho, e mantenha `COOKIE_SECURE=true` atrás de TLS. Escolha `APP_MODE=demo` ou `APP_MODE=live`.
3. Crie um arquivo de senha web no host, legível pelo UID 1000 do contêiner, com uma senha longa escolhida pelo operador. Defina `WEB_PASSWORD_SECRET_FILE` no `.env` para seu caminho absoluto. O repositório não gera nem inclui credenciais. Em secrets baseados em arquivo, o Compose preserva as permissões de origem; não conte com `uid/gid/mode` para remapeá-las. Provisione o arquivo para o UID 1000 (ou use o mecanismo de secrets do host/Coolify), sem tornar credenciais legíveis para todos. Veja a [documentação de secrets do Compose](https://docs.docker.com/reference/compose-file/services/#secrets).
4. Inicie com `docker compose up -d --build`. No Coolify, faça o deploy do serviço após informar as mesmas variáveis e disponibilizar o arquivo de senha no host.

O Compose mantém as bases SQLite e as credenciais do provider dentro de app.sqlite em `pi_agent_data`, montado em `/app/data`. O volume deve persistir entre recriações do contêiner. Execute apenas uma réplica: a aplicação mantém estado local e não coordena gravações entre instâncias.

## Proxy e origem

O contêiner escuta na porta `3000` apenas na rede Compose; encaminhe o domínio pelo proxy do Coolify ou por um proxy reverso que termine TLS. Defina `APP_ORIGIN` para a origem HTTPS que o usuário abre no navegador. Configure o proxy para preservar `Host` e `X-Forwarded-Proto`, encaminhar `text/event-stream` sem buffering nem compressão e permitir conexões SSE longas (timeout de leitura de pelo menos 10 minutos). Não exponha uma porta de host diretamente à internet.

## OpenAI, Telegram e MCP

`APP_MODE=live` habilita o provedor OpenAI. A autenticação do provedor ChatGPT é independente da senha web: conclua o OAuth interativamente na aplicação. Se o callback não puder ser aberto, use o prompt manual de URL de callback completa apresentado pela aplicação e conclua a troca no mesmo ambiente onde o serviço roda.

Telegram é opcional. Crie os arquivos do token do bot e do segredo do webhook no host. Em `.env`, informe `TELEGRAM_BOT_TOKEN_SECRET_FILE` e `TELEGRAM_WEBHOOK_SECRET_FILE`; depois descomente os dois arquivos de segredo, os mounts de segredo e as variáveis `TELEGRAM_*_FILE` no `docker-compose.yml`. Defina `TELEGRAM_ALLOWED_USERS` e `TELEGRAM_ALLOWED_CHATS` como listas separadas por vírgula, limitadas aos IDs autorizados.

MCP também é opcional e aceita endpoints HTTPS via Streamable HTTP; HTTP só é aceito em loopback para testes locais. Revise `mcp.json`, monte-o em `/app/config/mcp.json` como somente leitura e defina `MCP_CONFIG_FILE=/app/config/mcp.json`. Não monte sockets, diretórios amplos ou credenciais administrativas.

## Dados e manutenção

Proteja o host e o volume com criptografia de disco. Faça backups regulares offline do SQLite e dos demais arquivos de `/app/data`; teste a restauração antes de depender deles. Guarde cópias fora do servidor e restrinja o acesso aos backups. Para atualizar, obtenha a nova versão e execute `docker compose up -d --build`; mantenha o mesmo volume persistente.

O contêiner roda como usuário `node`, com sistema de arquivos raiz somente leitura, `/tmp` temporário, capacidades Linux removidas e `no-new-privileges`. A verificação de saúde consulta `/healthz` na porta interna `3000`.
