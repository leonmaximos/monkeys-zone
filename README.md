# Conversa — MVP de comunicação web

Plataforma com sessões anônimas, servidores públicos de até cinco participantes,
texto persistente em tempo real e voz WebRTC mesh. Cada servidor contém uma sala
integrada. Você entra inicialmente apenas no texto e escolhe quando entrar na voz.

## Pré-requisitos e instalação

- Rust via [rustup](https://rustup.rs/); `rust-toolchain.toml` fixa Rust 1.99.1,
  rustfmt e Clippy.
- Node.js 22.13+ na linha 22, 24.x ou 26+, npm 10+.
- Compilador C para SQLite incorporado (por exemplo, `build-essential` no Linux).
- Para E2E: Chromium do Playwright e suas bibliotecas de sistema.

Execute na raiz do monorepo:

```sh
cp .env.example .env
npm ci
cargo check --workspace --locked
```

Preserve uma `.env` já configurada. Não há servidor SQLite, Redis ou serviço de
mídia para instalar. O backend cria o banco e aplica migrations automaticamente.
Os lockfiles Cargo/npm são parte do projeto.

## Executar localmente

Terminal 1:

```sh
cargo run -p discord-backend --locked
```

Terminal 2:

```sh
npm run dev
```

Abra **http://127.0.0.1:5173**. A API escuta em `127.0.0.1:3000`.
O frontend usa o proxy `/api` do Vite, inclusive WebSocket, para manter cookies
na mesma origem. Use o mesmo hostname ao navegar; `localhost` e `127.0.0.1`
são hosts diferentes para cookies.

Informe seu nome, teste/configure os dispositivos se desejar e continue. Crie
um servidor e clique em **Entrar**. Texto funciona sem permissão de microfone.
A captura não começa automaticamente. Na sala, use **Entrar na voz**,
**Mutar microfone**, **Desmutar microfone** e **Sair da voz**. Configurações de
dispositivo também ficam disponíveis dentro da sala; alterá-las encerra a voz
para que a próxima entrada use os dispositivos escolhidos.

Para encerrar, use Ctrl+C. O backend trata também SIGTERM em Unix, fecha os
WebSockets e o pool SQLite. Portas ocupadas produzem erro; Vite não troca de
porta silenciosamente.

```sh
curl -i http://127.0.0.1:3000/health
```

Resposta: HTTP `200`, JSON `{"status":"ok"}`. Esse endpoint é de liveness;
a conexão SQLite e as migrations são verificadas antes de abrir a porta HTTP.

## Configuração

O backend lê `.env` com dotenvy sem substituir variáveis exportadas. Vite lê a
`.env` da raiz. Reinicie os serviços após alterar a configuração.

| Variável               | Padrão                                        | Uso                                                                                     |
| ---------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `BACKEND_ADDR`         | `127.0.0.1:3000`                              | IP e porta da API.                                                                      |
| `DATABASE_URL`         | `sqlite://data/discord.db`                    | Caminho relativo à raiz quando os comandos são executados nela.                         |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Origens explícitas, sem barra final. Também valida escrita HTTP e handshake WebSocket.  |
| `RUST_LOG`             | `info,tower_http=debug`                       | Filtro para logs JSON, sem corpos ou tokens.                                            |
| `COOKIE_SECURE`        | `false`                                       | Use `true` sob HTTPS. Cookie também é HttpOnly e SameSite=Lax, com Path=/api.           |
| `STUN_URLS`            | `stun:stun.l.google.com:19302`                | URLs separadas por vírgula; vazio permite testar só ICE local.                          |
| `TURN_URLS`            | vazio                                         | URLs `turn:`/`turns:` separadas por vírgula.                                            |
| `TURN_SHARED_SECRET`   | vazio                                         | Segredo privado compartilhado com um TURN compatível com credenciais REST coturn.       |
| `VITE_API_BASE_URL`    | vazio                                         | Vazio usa mesma origem; uma URL explícita exige configuração correta de CORS e cookies. |

Variáveis `VITE_*` são públicas e incorporadas ao build. Nunca coloque segredos
TURN nelas. O frontend obtém credenciais TURN de uma hora por uma rota autenticada;
o segredo de geração permanece no backend. Novas entradas na voz renovam a
configuração. Chamadas que precisarem renegociar depois da expiração devem sair
e entrar novamente na voz para obter novas credenciais.

## Testar remotamente com um túnel ngrok

O túnel aponta somente para o Vite: navegador → ngrok HTTPS → Vite:5173 →
proxy `/api` HTTP/WebSocket → Axum:3000. O backend permanece em loopback.
O domínio autorizado no Vite e a origem autorizada no Axum são verificações
independentes; liberar o hostname no Vite não libera o POST de sessão no backend.

Para o domínio `submersed-footwear-slimness.ngrok-free.dev`, ajuste somente estas
entradas na `.env` da raiz, preservando as demais:

```dotenv
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,https://submersed-footwear-slimness.ngrok-free.dev
COOKIE_SECURE=true
VITE_API_BASE_URL=
```

Em `apps/frontend/vite.config.ts`, mantenha a lista explícita:

```ts
allowedHosts: ['submersed-footwear-slimness.ngrok-free.dev'];
```

`allowedHosts` recebe somente hostname; `CORS_ALLOWED_ORIGINS` recebe a origem
com `https://`, sem caminho ou barra final. Não use `allowedHosts: true`, curingas
de ngrok ou reescrita de Origin. O proxy existente preserva `/api`, `Origin`,
`Cookie` e `Set-Cookie`, com `ws: true`; não precisa remover `/api`, definir
`cookieDomainRewrite` ou ativar `rewriteWsOrigin`. O cookie não possui Domain:
o navegador o associa ao domínio HTTPS acessado, apesar do upstream HTTP local.

Reinicie Axum e Vite após alterar a configuração. Variáveis já exportadas no
terminal prevalecem sobre `.env`: remova valores antigos dessas três variáveis
antes de iniciar os serviços, caso existam. Em três terminais, na raiz:

```sh
# Terminal 1
cargo run -p discord-backend --locked
```

```sh
# Terminal 2
npm run dev
```

```sh
# Terminal 3
ngrok http 5173
```

Confirme que o ngrok publicou o domínio configurado; se mudar, atualize as duas
listas explícitas e reinicie os serviços. Abra a URL HTTPS publicada e clique
em **Continuar**. O navegador deve enviar `POST /api/session` para essa mesma
origem, JSON `{display_name}`, `Content-Type: application/json` e `Origin` HTTPS.
O cliente usa `credentials: include`; o primeiro POST não exige cookie prévio.
A resposta deve ser 200, com cookie `comm_session`, HttpOnly, SameSite=Lax,
Secure e Path=/api. O GET posterior deve retornar a sessão e o WebSocket deve
conectar em `wss://<domínio>/api/ws` usando esse cookie.

O GET inicial sem cookie retornar **401** é esperado. Um POST retornar **403**
com JSON `code: forbidden` indica rejeição de origem pelo Axum; não é resolvido
apenas adicionando `allowedHosts`. Use a aba Network do navegador e o inspetor
local **http://127.0.0.1:4040** para conferir método, URL, Origin, status e corpo
da resposta. Não compartilhe o valor do cookie em logs ou capturas. Rejeição de
hostname pelo Vite e páginas de erro ngrok têm respostas distintas desse JSON.

As duas origens locais continuam autorizadas. Cookies Secure funcionam no
localhost/loopback dos navegadores que tratam essas origens como confiáveis;
HTTP em IP de LAN não recebe essa exceção — use o domínio HTTPS para esse caso.
HTTPS do túnel permite solicitar microfone, mas não garante conectividade WebRTC
entre redes: STUN/TURN continuam sujeitos às limitações descritas abaixo.

## Sessões, abas e presença

- O nome tem 2–32 caracteres Unicode após normalização de espaços. Não há senha
  nem verificação de identidade real. Nomes repetidos são permitidos.
- A credencial é gerada no backend; SQLite armazena apenas seu hash SHA-256.
  Um ID público ou uma preferência em localStorage não autentica o usuário.
- O cookie dura a sessão do navegador; o registro no backend expira em sete dias.
  Restauração de sessão ao reabrir o navegador depende da política dele.
- Preferências locais contêm apenas nome e IDs dos dispositivos. O nome de uma
  sessão já identificada não é alterado nesta versão.
- Uma sessão ocupa no máximo um servidor e uma vaga. Abas do mesmo perfil
  compartilham o cookie: a conexão mais recente assume a sessão, restaura a sala
  e encerra a voz anterior. A aba substituída avisa e oferece **Assumir nesta aba**.
- A voz nunca é restaurada automaticamente após reconexão ou troca de aba.
- Heartbeat a cada 10 s, timeout de inatividade de 30 s; após detectar a
  desconexão, a vaga fica reservada por 20 s. Um corte de rede sem fechamento
  pode levar aproximadamente 50 s, mais o intervalo de limpeza, para liberar a vaga.
- **Voltar à lista** libera a vaga imediatamente. Reconexão usa backoff de
  0,5–10 s com jitter, até oito tentativas, seguido de recuperação manual.

A presença reside na memória de **uma única instância**. Reiniciar o backend
zera presença/voz, mas preserva sessões, servidores e mensagens. Os clientes
reconectam e podem entrar novamente. Não execute múltiplas instâncias sem um
mecanismo adicional de coordenação de presença e eventos.

## Testar manualmente

### Dois usuários e texto

1. Abra um perfil normal e outro navegador/perfil independente. Duas abas do
   mesmo perfil representam a mesma sessão, não dois participantes.
2. Identifique-se com nomes diferentes. Crie um servidor e entre nos dois perfis.
3. Envie mensagens nos dois sentidos; confira nomes, horários e confirmação.
4. Saia e entre novamente: o histórico deve continuar disponível.
5. Reinicie o backend mantendo o mesmo SQLite. Após reconectar, entre no servidor
   novamente: as mensagens continuam disponíveis. Use **Carregar mensagens anteriores**
   para páginas anteriores às últimas 50.

### Cinco participantes e rejeição do sexto

1. Use seis perfis/contextos independentes. Identifique todos e entre com cinco
   no mesmo servidor, mesmo que usem só texto.
2. O sexto deve ver **5/5 · Lotado**, com entrada desabilitada. O backend também
   rejeita uma tentativa de entrada pelo protocolo com `server_full`.
3. Saia explicitamente com um participante: a ocupação deve cair imediatamente.
4. Feche outro perfil sem sair: sua vaga fica reservada por 20 s após detectar
   a desconexão e então é liberada. Uma queda silenciosa inclui o timeout de heartbeat.

### Microfone e transmissão de voz

1. Use fones de ouvido para evitar realimentação ao testar na mesma máquina.
2. Na identificação, clique em **Testar microfone**, permita o acesso e fale.
   O medidor deve variar. Clique em **Parar teste**. O teste não envia áudio a ninguém.
3. Nos dois perfis dentro da sala, clique em **Entrar na voz**. Aguarde o estado
   conectado do outro participante e fale alternadamente.
4. Mute um microfone: o outro perfil deve parar de ouvir essa pessoa. Desmute
   e confirme a retomada. Sair da voz deve encerrar a captura, mantendo o texto.
5. Confira desconexão de dispositivo, permissão negada e nova tentativa após
   corrigir a permissão. Se o navegador bloquear reprodução, use **Ativar áudio recebido**.

Os E2E usam entrada WAV sintética e WebRTC real. Eles medem RTP/energia recebida,
track habilitada/desabilitada, reprodução e liberação dos recursos. Isso não
substitui ouvir microfones físicos nem testar redes externas e outros navegadores.

## STUN, TURN e outras máquinas

STUN ajuda na descoberta de conectividade, mas não garante travessia de NAT ou
firewall. Redes restritivas podem exigir TURN. Para um TURN próprio compatível
com o mecanismo REST do coturn, configure o serviço com `use-auth-secret` e
`static-auth-secret`, usando o mesmo segredo no backend:

```dotenv
TURN_URLS=turn:turn.seu-dominio.example:3478?transport=udp,turns:turn.seu-dominio.example:5349?transport=tcp
TURN_SHARED_SECRET=SUBSTITUA_POR_UM_SEGREDO_ALEATORIO_LONGO
```

Esses endereços são exemplos de configuração, não um serviço provisionado.
Configure DNS, certificado e portas de relay no seu TURN. Não use credenciais
permanentes no frontend. Nenhum TURN externo foi validado nesta entrega.

Em outras máquinas, `127.0.0.1` aponta para a própria máquina do visitante.
Sirva frontend e `/api` por um proxy **HTTPS** com WebSocket habilitado, aponte
esse proxy para o backend e inclua a origem pública em `CORS_ALLOWED_ORIGINS`.
Use `COOKIE_SECURE=true`. A configuração HTTPS/proxy da sua infraestrutura não
é provisionada por este projeto. HTTP em um IP da LAN normalmente não habilita
microfone; localhost é uma exceção de desenvolvimento. Requisições com cookie
entre sites diferentes exigem decisões adicionais; prefira mesma origem.

Para expor apenas o Vite numa rede de desenvolvimento, o comando é
`npm run dev --workspace @discord/frontend -- --host 0.0.0.0`; ainda será
necessário HTTPS para voz fora de localhost e adicionar a origem acessada à lista.

## Contratos e segurança

- HTTP: sessão, lista/criação de servidores, histórico paginado e configuração ICE.
- WebSocket JSON versão 1: entrada/saída, presença, mensagens/ack, voz, mute e sinalização.
- Escritas HTTP exigem origem permitida e JSON. O handshake WebSocket exige
  cookie válido e origem permitida; sinalização só alcança pares na mesma voz.
- Limites: HTTP 16 KiB; WS 32 KiB; texto 2.000 caracteres; SDP 24.000 bytes;
  120 frames/10 s por conexão; 10 envios de texto/10 s por sessão;
  5 criações de servidor/minuto por sessão; 20 handshakes/minuto por sessão;
  120 novas sessões/minuto globalmente. São contenções básicas, não defesa contra DDoS.
- Cliente envia UUID por mensagem. O backend persiste antes do ack e deduplica
  por remetente/UUID. Reenvio do mesmo UUID com conteúdo diferente é rejeitado.
- O React renderiza mensagens como texto, sem HTML arbitrário.

Consulte [docs/architecture.md](docs/architecture.md) para o modelo de dados,
contratos completos, política de presença e decisões de mídia.

## Validação automatizada

Na raiz:

```sh
cargo fmt --all -- --check
cargo check --workspace --locked
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
npm run format:check
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

O teste Rust `tests/socket.rs` abre uma porta loopback efêmera. Outros testes
Rust usam o router e SQLite em memória. E2E inicia backend/Vite nas portas
3000/5173 e usa um banco temporário; pare os serviços locais antes de rodá-lo.
O teste de persistência inicia ainda um segundo processo Rust em uma porta
livre e reinicia esse processo contra o mesmo SQLite temporário.

Playwright usa Chromium com entrada sonora sintética, dois ou mais contextos
independentes e sem mocks de transporte. Relatórios de falha ficam em
`test-results/`. A verificação de tipos E2E roda junto de `test:e2e`.
Alguns sistemas precisam instalar bibliotecas nativas do navegador; consulte
[a documentação do Playwright](https://playwright.dev/docs/browsers#system-dependencies).

Para formatar: `cargo fmt --all` e `npm run format`.
Para testes contínuos: `npm run test:watch --workspace @discord/frontend`.

## Build, migrations e limites

`npm run build` gera `apps/frontend/dist/`. `npm run preview` permite inspeção
local na porta 5173 e usa o proxy `/api` configurado. Não rode dev e preview na
mesma porta. O backend não serve arquivos estáticos.

A migration `202610180001_mvp.sql` cria sessões, servidores, mensagens e índices.
Veja [as instruções de migrations](apps/backend/migrations/README.md).
SQLite usa WAL, foreign keys e pool de cinco conexões — esse limite é separado
do limite de participantes. Não altere migrations já aplicadas.

Não há contas tradicionais, convites, canais múltiplos, mensagens diretas,
vídeo, uploads ou papéis administrativos. Não há coordenação entre instâncias,
moderação, política automática de retenção, recuperação de identidade, backup
configurado ou observabilidade de produção. Escala, recuperação de desastre e
proteções de borda precisam ser definidas antes de exposição ampla.
