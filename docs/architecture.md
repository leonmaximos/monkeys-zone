# Arquitetura do MVP

## Topologia e módulos

Dois processos: SPA React/TypeScript e monólito Rust/Axum/Tokio. SQLite persiste
identidade anônima, servidores e mensagens. Uma única instância mantém presença
e entrega de eventos em memória. Não há Redis, broker, microserviços ou servidor
de mídia. Cada servidor público contém uma única sala integrada para texto e voz.

No backend:

| Módulo               | Responsabilidade                                                              |
| -------------------- | ----------------------------------------------------------------------------- |
| `main` / `config`    | Bootstrap, configuração, logs JSON, limpeza periódica e shutdown.             |
| `http` / `health`    | Composição de rotas/middleware e liveness.                                    |
| `identity`           | Validação de origem, emissão de cookie e autenticação de sessão.              |
| `servers`            | Validação, criação e listagem com ocupação atual.                             |
| `presence`           | Entrada atômica, capacidade, aba ativa, reserva de reconexão e estado de voz. |
| `messages`           | Validação/persistência idempotente e histórico paginado.                      |
| `realtime`           | Protocolo v1, transporte WS, heartbeat, limites e despacho autorizado.        |
| `signaling`          | Tipos SDP/ICE, validação e configuração ICE/TURN temporária.                  |
| `database` / `error` | Pool/migrations e erros HTTP JSON.                                            |

O router recebe `AppState`, com pool SQLx, `Arc<tokio::sync::Mutex<Hub>>`,
origens permitidas e configuração ICE. Handlers não recebem identidades
arbitrárias: autenticam o cookie. O transporte chama regras de presença,
persistência e sinalização explicitamente.

No frontend:

- `lib/contracts.ts`: DTOs, eventos tipados e validação de eventos recebidos.
- `lib/api.ts`: REST com cookies e erros; `lib/realtime.ts`: conexão WS,
  reconexão, confirmação e deduplicação no estado.
- `lib/store.ts`: Zustand para sessão pública, servidores, sala, mensagens,
  pendências e conexão. Credenciais não entram no store ou no localStorage.
- `features/audio`: dispositivos, medidor Web Audio e preferências não sensíveis.
- `features/servers` e `features/room`: telas de lista/criação e comunicação.
- `features/voice/mesh.ts`: ciclo de vida da mídia, peers e negociação;
  `useVoice.ts` integra o serviço ao estado React/Zustand.
- `components/ui`: primitivas shadcn/ui locais. Sem biblioteca de roteamento;
  as três telas são estados do fluxo, não URLs de salas compartilháveis.

## Modelo de dados

Migration: `apps/backend/migrations/202610180001_mvp.sql`.

| Tabela     | Colunas e restrições                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions` | `id` UUID público PK, `token_hash` SHA-256 UNIQUE, `display_name` 2–32 caracteres, `created_at`, `expires_at`.                                                                |
| `servers`  | `id` UUID PK, `name` 2–64 caracteres, `creator_id` FK para sessão, `created_at`.                                                                                              |
| `messages` | `id` INTEGER autoincrement PK, `client_id` UUID, `server_id` FK, `sender_id` FK, `sender_name`, `content` 1–2.000 caracteres, `created_at`; UNIQUE(`sender_id`, `client_id`). |

Horários são inteiros de milissegundos Unix. O ID incremental da mensagem é
seu cursor de ordenação consistente e é globalmente único dentro do banco.
O UUID de cliente é a chave de idempotência, não a identidade do remetente.
O nome é gravado na mensagem como snapshot histórico. Sessões expiradas não
são removidas automaticamente, preservando as referências históricas.

Índices cobrem expiração de sessão, ordenação de servidores e histórico por
(`server_id`, `id` DESC). Consultas usam binds SQLx, sem interpolar entradas em SQL.
SQLite usa WAL, foreign keys, pool de cinco conexões e timeouts de cinco segundos
para busy/acquire. O limite do pool não representa participantes.

Migrations são incorporadas no binário e aplicadas antes de abrir a porta HTTP.
Falhas impedem a inicialização. Não há macros `query!` que exijam um banco ativo
para compilar. `build.rs` observa novas migrations. Migrations aplicadas são
imutáveis; evolução usa novos arquivos.

## Sessão, cookie e proteção de origem

1. `POST /api/session` recebe somente `display_name` e exige origem permitida.
2. O backend normaliza espaços e valida 2–32 caracteres Unicode, sem controles
   restantes. Gera um UUID público e uma credencial aleatória de 64 dígitos hex
   a partir de duas UUIDs v4 independentes.
3. Somente o SHA-256 da credencial é persistido. O valor bruto vai em
   `comm_session`, HttpOnly, SameSite=Lax, Path=/api, Secure quando configurado.
4. Requisições seguintes recuperam sessão pelo hash, verificando expiração de
   sete dias. O cookie é de sessão do navegador, sem Max-Age. A resposta contém
   ID/nome/expiração, sem credencial.
5. Uma sessão existente com o mesmo nome é reutilizada. Renomear não faz parte
   desta versão. Um perfil independente cria outra sessão; abas compartilham cookie.

Escritas REST exigem `Origin` exatamente igual a uma origem configurada. Os
handlers JSON rejeitam campos inesperados. CORS habilita credenciais apenas
para as origens explícitas, métodos GET/POST e Content-Type. SameSite e a
validação obrigatória de origem protegem as escritas contra CSRF. Clientes de
linha de comando também precisam enviar Origin nas escritas.

O handshake WS verifica origem e cookie independentemente do CORS HTTP. Cookies
não vão em query string nem em subprotocolos. Uma sessão não escolhe seu ID.
A conexão também expira quando o prazo da sessão é atingido. Sem OAuth, senha,
contas tradicionais, papéis administrativos ou prova de identidade real.

O proxy `/api` do Vite mantém mesma origem no desenvolvimento. Em produção,
use HTTPS e proxy WS, cookie Secure e a origem pública configurada. CORS não é
um mecanismo de autorização e não bloqueia clientes externos ao navegador.

## Contrato REST

Todas as rotas abaixo usam JSON. Falhas de aplicação retornam status adequado
com `{"code":"...","message":"..."}`. Limites de transporte ou rotas inexistentes
podem produzir respostas nativas do Axum; não se deve assumir JSON em todo 404.

| Método e rota                                        | Entrada                    | Resposta / autorização                                                                     |
| ---------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /health`                                        | nenhuma                    | `200 {"status":"ok"}`, público; liveness, sem consulta ao banco.                           |
| `POST /api/session`                                  | `{"display_name":"Ana"}`   | `200 {id,display_name,expires_at}` e Set-Cookie na criação; origem obrigatória.            |
| `GET /api/session`                                   | cookie                     | `200 {id,display_name,expires_at}` ou 401.                                                 |
| `GET /api/servers`                                   | cookie                     | `200 Server[]`, ordenado por criação decrescente.                                          |
| `POST /api/servers`                                  | `{"name":"Café"}`          | `201 Server`, sessão e origem obrigatórias.                                                |
| `GET /api/servers/{id}/messages?limit=50&before=123` | cookie, cursor opcional    | `200 {messages:Message[],next_before}`; cursor numérico ou null; participação obrigatória. |
| `GET /api/rtc-config`                                | cookie                     | `200 {iceServers:RTCIceServer[],expiresAt:number}`; credenciais TURN temporárias.          |
| `GET /api/ws`                                        | upgrade WS, cookie, Origin | WebSocket autenticado, protocolo JSON v1.                                                  |

`Server` contém `id`, `name`, `creator_id`, `created_at`, `participants`,
`capacity` (sempre 5). A contagem inclui vagas reservadas durante reconexão.
Não há filtro por criador: todos os servidores são públicos.

O histórico aceita `limit` de 1 a 100, padrão 50, e `before` positivo exclusivo.
A busca usa ID descendente, mas a página retornada vem em ordem crescente.
`next_before` aponta para a mensagem mais antiga da página quando ainda existem
registros anteriores. O cursor não pode acessar outro servidor sem participação.

Códigos principais: `unauthorized` (401), `forbidden` (403), `not_found` (404),
`invalid_name`, `invalid_json`, `invalid_message`, `invalid_message_id`,
`invalid_pagination` (400), `session_exists`, `message_id_conflict` (409),
`rate_limited` (429) e `internal` (500).

## Protocolo WebSocket v1

Cada frame de aplicação é texto JSON com `v:1` e um discriminador `type`.
Campos extras do envelope são rejeitados. Formas SDP/ICE também são tipadas;
identidade do emissor vem exclusivamente do socket autenticado.

Cliente → servidor:

| `type`        | Campos adicionais           | Regra                                                                |
| ------------- | --------------------------- | -------------------------------------------------------------------- |
| `join`        | `server_id`                 | Servidor deve existir; entrada com capacidade atômica.               |
| `leave`       | nenhum                      | Libera servidor e voz imediatamente.                                 |
| `heartbeat`   | nenhum                      | Resposta `pong`.                                                     |
| `message`     | `client_id` UUID, `content` | Participação atual obrigatória; persistência antes do ack.           |
| `voice_join`  | nenhum                      | Participação no servidor obrigatória; cliente já obteve microfone.   |
| `voice_leave` | nenhum                      | Encerra estado de voz sem liberar texto/vaga.                        |
| `mute`        | `muted` booleano            | Apenas quando na voz; cliente aplica track.enabled localmente.       |
| `signal`      | `to`, `signal`              | Remetente/destinatário distintos, conectados e na mesma sala de voz. |

`signal` tem uma destas formas:

```json
{
  "kind": "description",
  "description": { "type": "offer", "sdp": "..." }
}
```

```json
{
  "kind": "candidate",
  "candidate": {
    "candidate": "...",
    "sdpMid": "0",
    "sdpMLineIndex": 0,
    "usernameFragment": "..."
  }
}
```

Descrições aceitam somente `offer` e `answer`. Campos opcionais de candidate
podem ser nulos/omitidos. O backend não interpreta ou registra SDP/ICE: valida
tipos/tamanho e autoriza o roteamento ao destinatário.

Servidor → cliente:

| `type`                | Campos adicionais                                                    |
| --------------------- | -------------------------------------------------------------------- |
| `welcome`             | `session_id`, `room` (snapshot ou null), `grace_seconds` (20).       |
| `joined` / `presence` | `room: {server_id,participants:Participant[]}`.                      |
| `left`                | nenhum; confirma saída.                                              |
| `servers_changed`     | nenhum; cliente atualiza listagem REST.                              |
| `notice`              | `server_id`, `display_name`, `action`: joined, left ou disconnected. |
| `message`             | `message:Message`, persistida e transmitida à sala.                  |
| `ack`                 | `message:Message`, confirmação idempotente ao emissor.               |
| `signal`              | `from` (autenticado pelo backend), `signal`.                         |
| `error`               | `code`, `message`, `client_id` ou null.                              |
| `pong`                | nenhum.                                                              |
| `replaced`            | Outra conexão assumiu a sessão; não reconectar automaticamente.      |
| `shutdown`            | Backend encerrando; reconexão normal posterior.                      |

`Participant` contém `id`, `display_name`, `connected`, `in_voice`, `muted`.
`Message` contém `id`, `client_id`, `server_id`, `sender_id`, `sender_name`,
`content`, `created_at`. Todos os envelopes de saída também têm `v:1`.

`server_full` e `already_in_server` são erros de entrada na sala. Erros de envio
incluem `client_id` para permitir reenvio. O frontend só adiciona ao histórico
confirmado após evento persistido/ack ou histórico REST; pendências aparecem
separadamente. A unicidade (`sender_id`, `client_id`) permite reenvio após queda.
O mesmo ID com outra sala ou conteúdo é conflito. Broadcast e ack duplicados
são mesclados pelo ID persistido.

## Presença e concorrência

O Hub guarda uma entrada por ID de sessão e uma geração aleatória por conexão.
Apenas a conexão atual pode executar comandos. Troca de aba substitui a geração,
notifica a conexão antiga e zera a voz. Uma desconexão tardia do socket antigo
não modifica a conexão nova.

Entrada, verificação de capacidade e atribuição de sala ocorrem sob a mesma
trava Tokio. Uma sessão só ocupa uma sala. Cinco entradas concorrentes ganham
vagas; as demais recebem `server_full`. O limite inclui texto e voz, nunca é
inferido do número de peers WebRTC ou da contagem que o navegador apresenta.

Autorização e mutação de eventos são serializadas com saída e troca de conexão.
A gravação SQLite de mensagens e a consulta de existência durante entrada
mantêm essa trava para evitar que uma saída/troca se intercale com autorização.
São operações assíncronas curtas, mas essa escolha limita throughput entre salas;
é uma troca deliberada para o MVP de instância única. Não há locks síncronos
bloqueando o runtime Tokio.

Cada socket tem canal de saída limitado a 128 eventos e timeout de escrita de
5 s. Estouro da fila marca o cliente para desconexão, evitando perda silenciosa
continuada. Heartbeat Ping/Pong a cada 10 s; 30 s sem frame recebido encerra a
conexão. O cliente também monitora respostas e reinicia a conexão após 30 s
sem eventos, encerrando a mídia. Desconexão desliga voz imediatamente e reserva a vaga de texto por 20 s.
Um reaper a cada segundo remove reservas expiradas. Saída explícita é imediata.

Reconexão restaura a mesma vaga e sala dentro da reserva, mas não o microfone.
Depois da expiração ou reinício do backend, o cliente volta à lista. Histórico
recente é recarregado e pendências da sala restaurada são reenviadas com o mesmo
UUID. A interface permite paginação das mensagens mais antigas.

## Voz real e ciclo de vida

A captura começa somente por teste explícito de microfone ou entrada explícita
na voz. O teste usa getUserMedia + AudioContext/AnalyserNode para RMS e não conecta
a saída nem transmite. Tracks, contexto e animation frame são encerrados ao
parar/desmontar; captura que resolve depois do cancelamento também é encerrada.

Na voz, o serviço obtém áudio e configuração ICE, envia `voice_join` e aguarda o
snapshot confirmar participação. Cria um RTCPeerConnection por participante
remoto na voz, adicionando a mesma track local aos peers. Um grupo com cinco
participantes tem até quatro peers por navegador e dez pares no total.

Na conexão inicial, a ordenação lexical dos IDs escolhe um único iniciador por
par, evitando ofertas simultâneas. Perfect negotiation trata colisões posteriores:
a mesma ordenação define o peer polite, com rollback implícito e fila assíncrona
por peer. Candidates recebidos antes da descrição aceita são preservados, inclusive
durante uma oferta ignorada; usernameFragment descarta ICE de gerações antigas. Alterações de
participação adicionam/removem peers. Falha ICE tenta restart, depois informa
a limitação da rede. Desconexão temporária dispara tentativa de restart após 8 s.

Tracks remotas alimentam elementos audio individuais; nunca se reproduz a
track local. setSinkId seleciona saída quando suportado. Bloqueio de autoplay
produz ação explícita para retomar a reprodução. Mute alterna enabled da track
local compartilhada e envia o estado para o backend. Estado anunciado não é
tratado como uma prova de que um cliente modificado realmente silenciou sua mídia.

Sair da voz, sair da sala, perder conexão, trocar de aba ou desmontar a tela
encerra tracks, peer connections, timers e elementos de reprodução. Voz não é
restaurada automaticamente. Desconexão de microfone encerra voz com mensagem;
a configuração permite selecionar outro dispositivo e entrar novamente.

A seleção de dispositivos usa enumerateDevices e trata devicechange. Preferências
persistem localmente; IDs inexistentes voltam ao padrão. Navegadores podem
restringir labels/dispositivos até conceder permissão e podem não suportar saída
selecionável. Negar microfone não bloqueia texto.

O backend emite credenciais TURN REST compatíveis com coturn: username com
expiração Unix de uma hora + ID de sessão, credential HMAC-SHA1 em Base64 usando
segredo privado. URLs STUN/TURN são configuráveis. O cliente obtém credenciais
novas a cada entrada na voz; chamadas longas que precisarem renegociar após a
expiração devem renovar a participação. STUN não garante conectividade externa.

O serviço de mídia fica separado da UI e do transporte. Uma SFU futura poderá
substituir `MeshVoice` e seu adaptador de sinalização mantendo conceitos de
participação e mute; isso exigirá novos contratos de negociação. Não se promete
reutilizar SDP mesh sem mudanças.

## Limites e segurança básica

- REST: corpo de 16 KiB; WebSocket: frame/mensagem de 32 KiB.
- Texto: 1–2.000 caracteres após trim, sem NUL; client_id deve ser UUID.
- SDP: até 24.000 bytes; candidate: até 4.096, metadados até 256 cada.
- Até 120 frames/10 s por conexão; cinco eventos JSON malformados encerram o socket.
- Texto: 10 envios/10 s por sessão, incluindo reenvios; não reinicia ao reconectar.
- Servidores: cinco criações/minuto por sessão. Novas sessões: 120/minuto global.
- Novos handshakes: 20/minuto por sessão; contenção adicional de novos sockets
  quando o Hub chega a 1.024 entradas. Limites não substituem proteção de borda.
- Apenas a mesma sala de voz autoriza sinalização; remetente vem do socket.
- Conteúdo é renderizado como texto React, sem dangerouslySetInnerHTML.
- Logs JSON contêm metadados e categorias de erro, sem tokens, corpos ou SDP.

Não há controle de identidade real, moderação, expulsão, recuperação de sessão,
retenção automática, backup provisionado, métricas de produção ou coordenação
entre instâncias. Nomes duplicados são permitidos. Mesh cresce em custo de CPU
e banda; cinco participantes não garantem qualidade em todos os dispositivos.

## Validação e evolução

Rust cobre health/CORS, sessão/origem/expiração, nomes, criação/listagem,
concorrência de entrada, capacidade, saída, reconexão, isolamento, persistência,
idempotência, paginação, eventos inválidos e autorização de sinalização. Um teste
abre um WebSocket real em loopback para validar handshake e recuperação de
payload inválido. Vitest cobre os fluxos de UI e APIs de mídia com mocks somente
nos testes.

Playwright usa contextos independentes com o backend real para texto,
reconexão, capacidade/rejeição do sexto, abas, expiração de presença, layout
móvel e áudio. Usa WAV sintético como entrada do Chromium, sem mock de WebRTC,
e verifica energia recebida, mute real, retomada e liberação de recursos. Outro
fluxo reinicia um processo Rust real e verifica persistência no mesmo SQLite.
Isso não valida escuta física, Firefox/Safari, TURN externo ou redes WAN/NAT
restritivas. Esses cenários permanecem necessários antes de alegar suporte amplo.

Evoluções possíveis, fora desta entrega: SFU, coordenação distribuída de presença,
observabilidade, retenção/backup, política de abuso, paginação da listagem de
servidores, URLs de salas e negociação de credenciais TURN durante chamadas longas.
Não fazem parte do MVP canais múltiplos, convites, vídeo, uploads, bots ou papéis.

Referências primárias:
[Axum WebSocketUpgrade](https://docs.rs/axum/latest/axum/extract/struct.WebSocketUpgrade.html),
[perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation),
[energia de áudio RTP](https://developer.mozilla.org/en-US/docs/Web/API/RTCInboundRtpStreamStats/totalAudioEnergy)
e [SQLx migrations](https://docs.rs/sqlx/0.8.6/sqlx/macro.migrate.html).
