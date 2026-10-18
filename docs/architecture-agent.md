A arquitetura atual é coerente para o MVP de texto e voz com cinco sessões por sala. Ela oferece uma base aproveitável para compartilhamento de tela, mas ainda precisa de mudanças no modelo de mídia, na recuperação de conexões e na observabilidade. Não há evidência suficiente para prometer 1440p60 ou 4K60.

Minha recomendação é uma transição híbrida: preservar inicialmente a voz mesh e usar SFU para o compartilhamento de tela, mantendo identidade, salas, autorização e persistência no monólito Rust.

A auditoria foi somente de leitura. Consultei documentação, manifests, código Rust/TypeScript e testes existentes. Não alterei arquivos, executei testes, iniciei serviços ou apliquei migrations. O funcionamento entre redes diferentes foi informado por vocês; não foi reproduzido nesta auditoria.

1. Arquitetura atual

This Mermaid diagram uses features the terminal renderer doesn't support.
flowchart TB
    subgraph A["Navegador A"]
        UIA["React + Zustand"]
        RTCA["MeshVoice / RTCPeerConnection"]
        MICA["Microfone"]
        UIA --> RTCA
        MICA --> RTCA
    end

    subgraph B["Navegador B"]
        UIB["React + Zustand"]
        RTCB["MeshVoice / RTCPeerConnection"]
        MICB["Microfone"]
        UIB --> RTCB
        MICB --> RTCB
    end

    EDGE["ngrok HTTPS → Vite:5173<br/>Proxy /api HTTP + WebSocket"]

    subgraph BACK["Uma instância Axum / Tokio"]
        HTTP["REST<br/>sessões, servidores, histórico, ICE"]
        WS["WebSocket v1<br/>texto, presença, SDP, ICE"]
        HUB["Hub em memória<br/>Mutex global<br/>sessão, conexão, sala, voz"]
        DOM["identity / servers / messages"]
        REAPER["Limpeza periódica"]
        HTTP --> DOM
        HTTP --> HUB
        WS --> HUB
        WS --> DOM
        REAPER --> HUB
    end

    DB[("SQLite / SQLx<br/>sessões, servidores, mensagens")]
    STUN["STUN"]
    TURN["TURN opcional<br/>não configurado no .env inspecionado"]

    UIA <-->|"HTTPS / WSS"| EDGE
    UIB <-->|"HTTPS / WSS"| EDGE
    EDGE --> HTTP
    EDGE --> WS
    DOM --> DB

    RTCA <-->|"Mídia WebRTC direta"| RTCB
    RTCA -.-> STUN
    RTCB -.-> STUN
    RTCA -.-> TURN
    RTCB -.-> TURN

O Axum transporta sinalização e eventos de aplicação. Ele não recebe, mistura, codifica ou encaminha o áudio.

O túnel HTTP do ngrok permite acessar frontend, API e WebSocket. A mídia WebRTC utiliza a conectividade negociada por ICE, independentemente desse túnel.

2. Mapa dos principais arquivos

Os caminhos abaixo são relativos à raiz do projeto.

| Área | Arquivos e funções relevantes | Responsabilidade |
|---|---|---|
| Inicialização | main.rs (apps/backend/src/main.rs:8), config.rs (apps/backend/src/config.rs:27) | Ambiente, logs JSON, listener, limpeza e shutdown. |
| Estado compartilhado | lib.rs — AppState (apps/backend/src/lib.rs:18) | Pool SQLite, Arc<Mutex<Hub>>, origens e ICE. |
| HTTP | http.rs — application (apps/backend/src/http.rs:14) | Rotas, CORS, limite de corpo e tracing. |
| Identidade | identity.rs (apps/backend/src/identity.rs:33) | Origin, emissão de credencial e autenticação por cookie. |
| Servidores | servers.rs (apps/backend/src/servers.rs:30) | Criação, consulta e contagem de ocupação. |
| Presença | presence.rs — Hub (apps/backend/src/presence.rs:64) | Capacidade, conexão vigente, sala, voz e reserva de reconexão. |
| Texto | messages.rs (apps/backend/src/messages.rs:27) | Persistência idempotente e histórico paginado. |
| Tempo real | realtime.rs (apps/backend/src/realtime.rs:96) | Protocolo, limites, heartbeat e despacho de comandos. |
| Sinalização | signaling.rs (apps/backend/src/signaling.rs:42) | Configuração ICE, credenciais TURN e validação SDP/ICE. |
| Banco | database.rs (apps/backend/src/database.rs:21), migration (apps/backend/migrations/202610180001_mvp.sql:1) | Pool, WAL, migrations e modelo persistido. |
| Fluxo de telas | App.tsx (apps/frontend/src/App.tsx:17), features/servers/ServerList.tsx, features/room/ServerRoom.tsx | Identificação, diretório e sala integrada. |
| Transporte frontend | api.ts (apps/frontend/src/lib/api.ts:16), realtime.ts (apps/frontend/src/lib/realtime.ts:17) | REST com cookies, WebSocket, reconexão e confirmações. |
| Estado e contratos | store.ts (apps/frontend/src/lib/store.ts:24), contracts.ts (apps/frontend/src/lib/contracts.ts:38) | Estado público, mensagens e validação de eventos recebidos. |
| Dispositivos | devices.ts (apps/frontend/src/features/audio/devices.ts:67), AudioSetup.tsx | Captura de teste, medidor, preferências e dispositivos. |
| Voz | mesh.ts (apps/frontend/src/features/voice/mesh.ts:32), useVoice.ts (apps/frontend/src/features/voice/useVoice.ts:8) | Mídia WebRTC e integração com React/Zustand. |

A separação de domínios existe, embora realtime::handle concentre parte importante da coordenação entre autorização, persistência e distribuição.

3. Dados, sessões, presença e texto

O modelo persistido possui três tabelas:

| Tabela | Dados e garantias |
|---|---|
| sessions | UUID público, hash SHA-256 da credencial, nome e expiração. |
| servers | UUID, nome, criador e data de criação. |
| messages | ID incremental, UUID do cliente, sala, remetente, nome histórico, conteúdo e horário. Unicidade por (sender_id, client_id). |

Há índices para expiração, listagem de servidores e histórico por sala. Presença, conexão ativa, mute e participação na voz ficam exclusivamente em memória.

O fluxo de sessão está corretamente separado da identidade pública:

- O backend gera a credencial imprevisível e persiste somente seu hash.
- O cookie é HttpOnly; SameSite=Lax; Path=/api, com Secure condicionado à configuração.
- A sessão expira no backend em sete dias; o cookie não possui Max-Age.
- localStorage guarda preferências, sem autenticar o usuário.
- Escritas HTTP e handshake WebSocket exigem Origin explicitamente permitido.

Essas regras aparecem em authenticate e identify (apps/backend/src/identity.rs:54).

A presença usa uma entrada por sessão e um identificador novo por conexão. Uma nova aba assume a sessão e invalida os comandos da conexão anterior. A desconexão antiga não consegue remover a conexão nova.

O limite de cinco sessões é atômico: contagem e atribuição da sala acontecem sob o mesmo lock em Hub::join (apps/backend/src/presence.rs:187). Inclui participantes somente de texto e vagas reservadas. Uma sessão só pode ocupar um servidor.

Após desconexão detectada, a vaga permanece reservada por 20 segundos. O heartbeat trabalha em intervalos de dez segundos e considera 30 segundos sem frames. Assim, uma queda silenciosa demora mais para liberar a vaga do que uma saída explícita; esses tempos também sofrem a granularidade dos timers e eventuais atrasos do processo.

No texto:

- O backend valida UUID e conteúdo de até 2.000 caracteres.
- Persiste antes de emitir message e ack.
- Reenvios reutilizam o UUID e são idempotentes.
- O histórico usa cursor pelo ID incremental, com páginas de até 100 registros.
- O frontend mescla broadcast e confirmação pelo ID persistido.
- O conteúdo é renderizado como texto React.

Evidências: persist (apps/backend/src/messages.rs:27), history (apps/backend/src/messages.rs:74), despacho de mensagem (apps/backend/src/realtime.rs:251) e mergeMessages (apps/frontend/src/lib/store.ts:35).

4. Auditoria WebRTC

| Questão | Resposta confirmada no código |
|---|---|
| 1. É realmente mesh P2P? | Sim. MeshVoice.sync() cria um peer para cada participante remoto conectado à voz. Não existe servidor de mídia. sync (apps/frontend/src/features/voice/mesh.ts:113). |
| 2. Quantas conexões por participante? | N − 1, considerando os participantes na voz. Com cinco, são quatro objetos locais por navegador: 20 objetos RTCPeerConnection, correspondendo a dez pares. createPeer (apps/frontend/src/features/voice/mesh.ts:131). |
| 3. O áudio trafega diretamente? | O desenho permite mídia direta entre navegadores; TURN pode intermediar quando configurado e selecionado por ICE. O caminho de uma chamada específica só pode ser confirmado pelo candidate pair selecionado. |
| 4. Há TURN configurado? | Há suporte no backend a credenciais temporárias HMAC com validade de uma hora. No .env inspecionado, URL e segredo TURN estão vazios. Isso não comprova o ambiente efetivo de um processo já iniciado. configuração (apps/backend/src/signaling.rs:42). |
| 5. Como ocorre a troca de ICE? | onicecandidate envia eventos signal; o backend autoriza e encaminha. O destinatário armazena até 128 candidates enquanto aguarda descrição aceita. Há filtro por usernameFragment. envio (apps/frontend/src/features/voice/mesh.ts:150), recepção (apps/frontend/src/features/voice/mesh.ts:253), addCandidate (apps/frontend/src/features/voice/mesh.ts:272). |
| 6. Como ocorre SDP? | onnegotiationneeded chama setLocalDescription() e envia offer/answer. Uma offer recebida passa por setRemoteDescription(), geração de answer e resposta pelo WS. negociação (apps/frontend/src/features/voice/mesh.ts:165), receive (apps/frontend/src/features/voice/mesh.ts:215). |
| 7. Como resolve colisões? | Ordenação lexical dos IDs escolhe o iniciador inicial e o peer polite. Usa makingOffer, settingAnswer, ignoreOffer e fila por peer; o lado polite depende do rollback implícito de setRemoteDescription(). Existe tratamento de perfect negotiation, mas sua robustez sob renegociação de vídeo não foi demonstrada. |
| 8. Como funciona mute? | Altera enabled das tracks locais de áudio e anuncia o estado ao backend. A mesma track alimenta os peers. Isso silencia o conteúdo do microfone sem fechar a conexão. mute (apps/frontend/src/features/voice/mesh.ts:285). |
| 9. Como sai da voz? | Envia voice_leave, invalida operações de captura pendentes, para tracks e fecha peers. A sessão continua no texto. leave (apps/frontend/src/features/voice/mesh.ts:323). |
| 10. As tracks são encerradas? | Os caminhos normais chamam stop() nas tracks locais. Captura resolvida depois de cancelamento também é encerrada. O fechamento remoto fecha PC e remove referências do elemento de áudio. |
| 11. Há risco de vazamento? | A limpeza normal é explícita e bem estruturada. Há risco de retenção prolongada do microfone se a consulta de configuração ICE ficar pendente; detalhado nos achados. Não foi comprovado crescimento permanente de memória. |
| 12. Suporta adicionar vídeo hoje? | A API WebRTC permite, mas o serviço atual captura somente áudio e não oferece operações de publicação de vídeo. ontrack usa um único <audio> por peer e não distingue tipos de mídia. audioConstraints (apps/frontend/src/features/audio/devices.ts:39), ontrack (apps/frontend/src/features/voice/mesh.ts:158). |
| 13. Como seria a renegociação? | Há infraestrutura reaproveitável em onnegotiationneeded e receive. Faltam gerenciamento de senders/transceivers, inclusão e remoção de tela, identificação das publicações e testes das transições. |
| 14. Diferencia participante, conexão e track? | Parcialmente. O backend distingue sessão e geração de conexão. O frontend identifica peers pelo participante. Não há identidade explícita de publicação, geração da chamada ou associação de mídia por mid/origem. |
| 15. Como reage à perda de conectividade? | WS reconecta com backoff e jitter, até oito tentativas após fechamentos. A voz é encerrada quando o estado deixa de ser online. Em mídia, failed permite uma tentativa de restartIce; disconnected agenda restart após oito segundos. Não há prazo específico para peers presos em new/connecting. recuperação WS (apps/frontend/src/lib/realtime.ts:273), recuperação RTC (apps/frontend/src/features/voice/mesh.ts:194). |

A distinção entre participante e publicação precisa ser explícita: IDs de tracks enviados e recebidos não possuem correspondência direta garantida. O padrão descreve a associação por sender/receiver e transceiver mid. Especificação WebRTC.

5. Fluxo de voz de ponta a ponta

1. O usuário entra na sala inicialmente pelo texto.
2. Ao solicitar voz, MeshVoice.join() obtém o microfone e consulta /api/rtc-config.
3. Envia voice_join; o backend verifica participação na sala.
4. O snapshot de presença confirma in_voice.
5. Cada navegador cria peers para os demais participantes da voz.
6. O iniciador de cada par envia offer; o outro aplica a descrição e responde.
7. Candidates são encaminhados pelo WebSocket autenticado.
8. ICE seleciona a conectividade; a mídia passa entre os endpoints, diretamente ou via relay.
9. Tracks recebidas alimentam elementos de áudio.
10. Mute altera a track local. Saída ou perda do WS encerra os recursos de voz.

A integração com o ciclo de vida da aplicação está em useVoice (apps/frontend/src/features/voice/useVoice.ts:17). Ela também remove subscriptions e listeners na desmontagem e encerra mídia em pagehide.

6. Desempenho e gerenciamento de recursos

Tokio e operações bloqueantes. Há uma tarefa explícita de limpeza periódica e um loop assíncrono por WebSocket. Não encontrei trabalho síncrono pesado evidente nos caminhos normais da aplicação. O problema principal identificado é de serialização lógica, devido ao lock global mantido durante operações assíncronas.

Lock global. realtime::handle (apps/backend/src/realtime.rs:226) mantém o guard durante consulta de servidor e persistência. messages::history (apps/backend/src/messages.rs:83) também mantém o guard durante a consulta. Uma espera por SQLite pode atrasar presença, sinalização, entrada e limpeza de outras salas. A estrutura é comprovada; a latência resultante não foi medida.

WebSocket. Cada conexão possui fila de 128 eventos e timeout de escrita de cinco segundos. try_send evita que o broadcast espere diretamente por clientes lentos. Entretanto, leitura, escrita e despacho acontecem no mesmo loop; uma escrita lenta também adia a leitura daquele socket. Os limites reduzem o risco, mas não estabelecem um orçamento global estrito de memória.

Broadcast. room_event, snapshot e count percorrem os slots. servers::all() repete a contagem para cada servidor: custo aproximadamente proporcional a servidores × slots. servers_changed é global e faz os clientes recarregarem a lista completa. Há coalescência por cliente, mas permanece amplificação entre clientes. Hub (apps/backend/src/presence.rs:338), listagem (apps/backend/src/servers.rs:30), refreshServers (apps/frontend/src/lib/realtime.ts:72).

SQLite. WAL, binds, índices e pool de cinco conexões são escolhas razoáveis para o MVP. O pool não permite cinco escritores simultâneos no SQLite. Existem timeouts de cinco segundos para aquisição e contenção do banco. Não há evidência que justifique trocar SQLite ou aumentar o pool agora; primeiro devem ser medidos duração das consultas, espera e volume de escrita.

Memória e CPU no navegador. Todas as mensagens carregadas permanecem no store e são renderizadas. A mesclagem recria um mapa e ordena o conjunto acumulado. Em salas longas, isso pode aumentar memória, processamento e trabalho de DOM, competindo futuramente com captura e vídeo. store (apps/frontend/src/lib/store.ts:35), renderização (apps/frontend/src/features/room/ServerRoom.tsx:110).

Persistência e limpeza. O reaper remove presença desconectada; ele não remove sessões expiradas do SQLite. Servidores e mensagens também não possuem retenção automática. Esse crescimento é intencional/documentado, mas precisa de política operacional antes de exposição ampla.

7. Segurança

Os pontos fortes confirmados são:

- Autenticação pelo cookie validado no servidor, sem confiar no ID do cliente.
- Origin obrigatório nas escritas e no handshake WS; CORS explícito com credenciais.
- Remetente de sinalização definido pelo socket autenticado.
- Sinalização restrita a participantes distintos na mesma sala de voz.
- Verificação da geração vigente antes de executar comandos.
- SQL parametrizado e conteúdo textual renderizado sem interpretação de HTML.
- Credencial permanente TURN mantida no backend.
- Logs de aplicação sem inclusão explícita de cookies, corpos de mensagens, SDP ou ICE.

As principais proteções de transporte são:

| Proteção | Limite atual |
|---|---:|
| Corpo HTTP | 16 KiB |
| Frame/mensagem WS | 32 KiB |
| Eventos por conexão | 120 frames/10 s |
| Texto por sessão | 10 envios/10 s |
| Texto por mensagem | 2.000 caracteres |
| SDP | 24.000 bytes |
| Criação de servidores | 5/minuto por sessão |
| Novas sessões | 120/minuto globalmente |
| Handshakes | 20/minuto por sessão |

Evidências: router (apps/backend/src/http.rs:14), parse e upgrade (apps/backend/src/realtime.rs:96), limites (apps/backend/src/presence.rs:73), authorize_signal (apps/backend/src/presence.rs:262).

Existem limites importantes:

- Cinco sessões não equivalem a cinco pessoas. Uma pessoa pode criar identidades em perfis independentes e ocupar vagas. Isso decorre do modelo anônimo.
- Não encontrei caminho evidente para uma sexta sessão entrar na mesma sala pela implementação normal, nem para falsificar o remetente por ID público.
- O backend valida formato/tamanho do SDP, sem restringir seu conteúdo a áudio. Clientes modificados podem negociar outras mídias entre participantes autorizados.
- Em P2P, um indicador de mute ou a revogação de sinalização não constituem fiscalização central do fluxo de mídia.
- O tracing HTTP usa a configuração padrão, sem redação específica de URI. A aplicação não coloca credenciais em URLs, mas essa convenção precisa ser preservada.

8. Achados classificados

Não identifiquei um achado CRÍTICO comprovado nesta leitura. Isso não equivale a uma certificação de segurança; não houve teste adversarial.

As probabilidades abaixo são avaliações qualitativas condicionadas ao cenário. Os esforços são estimativas em dias de engenharia, incluindo testes, sem representar compromisso de prazo.

| ID / gravidade | Evidência e impacto | Probabilidade | Correção sugerida / esforço | Antes da tela? |
|---|---|---|---|---|
| A1 — ALTO: lock global durante I/O | realtime::handle e messages::history aguardam SQLite com o Hub bloqueado. Uma sala pode atrasar controle das demais. | Relevante sob contenção, disco lento ou muitas requisições; impacto não medido. | Reduzir a seção crítica, preservando autorização e capacidade atômicas com revalidação de geração/participação. 2–5 dias. | Sim, antes de ampliar carga. |
| A2 — ALTO: mídia sem separação entre áudio e vídeo | ontrack substitui audio.srcObject por stream recebido. Um stream separado de tela pode substituir a reprodução da voz. Faltam publicação e assinatura. | Alta se vídeo for acrescentado diretamente ao serviço atual. | Separar captura, publicação, recepção e renderização por origem/tipo; manter ciclo de vida independente do microfone. 4–8 dias de fundação. | Sim. |
| A3 — ALTO: teto global de conexões não é estrito | allow_connection() verifica slots antes do upgrade; connect() insere depois, sem reserva atômica. Slots também não representam todos os sockets antigos ainda encerrando. upgrade (apps/backend/src/realtime.rs:129), connect (apps/backend/src/presence.rs:104). | Condicionada a handshakes concorrentes e abuso; não reproduzida. | Reservar admissões atomicamente, contabilizar conexões pendentes/ativas e liberar reservas em falhas. Complementar com limites de borda. 2–4 dias. | Sim para exposição pública. |
| A4 — ALTO condicional: credenciais TURN acessíveis a qualquer sessão | /rtc-config exige sessão, mas não participação na sala nem quota de emissão. Credenciais têm uma hora de validade e podem ser usadas fora da UI. config (apps/backend/src/signaling.rs:42). | Risco relevante quando TURN for habilitado publicamente; desabilitado no .env lido. | Autorizar emissão conforme uso, limitar requisições e provisionar quotas globais, alocações e banda no relay. 2–4 dias, mais operação. | Antes de habilitar TURN público. |
| A5 — MÉDIO: captura pode ficar pendente sem prazo de aplicação | join() abre o microfone antes de aguardar configuração ICE; o timeout só começa depois. request() não define timeout ou cancelamento. | Depende de requisição lenta/travada. | Timeout/cancelamento do fluxo, limpeza em falhas e testes de respostas tardias. 1–2 dias. | Sim, reutilizando o padrão na tela. |
| A6 — MÉDIO: recuperação RTC incompleta | Sem prazo para new/connecting; política de restart pouco uniforme; expiresAt não é utilizado para renovar ICE; sinais não possuem geração explícita de chamada. | Redes instáveis, chamadas longas e saída/entrada rápidas. | Máquina de estados de recuperação, renovação de credenciais e identificador de geração da mídia. 3–5 dias. | Sim para qualidade pretendida. |
| A7 — MÉDIO: crescimento de dados e histórico no cliente | Não há retenção; lista de servidores não é paginada; histórico carregado permanece integralmente no store/DOM. | Cresce com duração e uso acumulado. | Política de retenção/arquivo, paginação de servidores e janela de renderização/cache. 3–6 dias. | Antes de uso prolongado em produção. |
| A8 — MÉDIO: amplificação de presença e listagem | Contagens percorrem slots e mudanças provocam refresh global da lista inteira. | Baixa com poucos usuários; aumenta com salas e conexões. | Contadores/índices por sala e atualizações incrementais, orientados por medição. 2–4 dias. | Recomendada antes de escalar. |
| A9 — MÉDIO: qualidade e operação sem observabilidade | getStats() aparece nos E2E, não na aplicação. Health é liveness; não há métricas de mídia, espera do Hub ou banco. | Impede diagnosticar objetivamente degradação. | Estatísticas RTC amostradas, métricas de API/lock/banco e indicadores operacionais. 3–5 dias. | Sim, antes de validar 60 FPS. |
| A10 — BAIXO: timers de confirmação sem controle por tentativa | sendMessage() cria timeout sem armazenar/cancelar seu handle. Um timeout antigo pode marcar um reenvio recente do mesmo UUID como falho. sendMessage (apps/frontend/src/lib/realtime.ts:107). | Condicionada a reenvio perto do prazo anterior. | Correlacionar timer à tentativa e cancelar em confirmação/encerramento. 0,5–1 dia. | Não bloqueia vídeo. |

No caso TURN, o coturn oferece quotas de alocações e limites de banda por sessão e globais. A configuração real desses controles não consta no projeto. Documentação coturn.

9. Preparação para compartilhamento de tela

| Capacidade | Situação atual e trabalho necessário |
|---|---|
| getDisplayMedia | Ausente. Precisa de captura explícita, consentimento e tratamento de cancelamento. |
| Adicionar vídeo | Parcialmente reaproveitável no nível WebRTC; sem API de publicação no serviço atual. |
| Renegociação | Infraestrutura existente, sem cobertura de inclusão/remoção de vídeo em chamadas ativas. |
| Voz e vídeo simultâneos | Possível pela tecnologia; faltam separação de tracks, renderizadores e políticas de recursos. |
| Quem transmite | Sem estado de publicação nem autorização específica. |
| Quem assiste | Sem assinatura, seleção de espectadores ou recepção independente da voz. |
| Parar captura | Existe padrão de limpeza de áudio; faltam ended da tela e remoção exclusiva da publicação. |
| Quatro espectadores | Mesh permitiria quatro destinatários, com multiplicação do upload. Sem validação de vídeo. |
| Resolução e FPS | Sem configuração ou verificação dos valores efetivamente capturados/recebidos. |
| Codecs | Negociação padrão do navegador; sem preferências ou matriz de compatibilidade. |
| Bitrate | Sem orçamento explícito por publicação ou espectador. |
| Qualidade | Sem telemetria RTC de produção. |

Captura de tela exige seleção e consentimento do usuário a cada solicitação. Pedir resolução e FPS não garante que o navegador entregue os valores desejados; é necessário observar os settings e a mídia efetivamente produzida. A especificação também restringe o uso de min/exact na solicitação inicial. Screen Capture — W3C.

Para expansão, convém modelar separadamente:

- Participante e conexão.
- Publicação de microfone e publicação de tela.
- Geração da publicação.
- Assinaturas dos espectadores.
- Sender/transceiver e associação da mídia recebida.
- Qualidade solicitada e qualidade observada.

A adição de vídeo pode comprometer a voz por três caminhos: substituição incorreta de streams no código atual, compartilhamento de CPU/GPU e saturação do upload. Usar conexões separadas reduz acoplamento de negociação, mas não elimina competição por hardware e rede.

Há também limites de sinalização a reavaliar com SDP representativo de áudio+vídeo: 24 KB por descrição e 120 frames/10 s agregados por conexão. Não há evidência de que sejam insuficientes hoje; também não devem ser ampliados sem medição.

10. 1440p60, 4K60 e banda

Os volumes abaixo são cálculos de pixels, não benchmarks nem estimativas de bitrate:

| Meta | Pixels por quadro | Pixels por segundo |
|---|---:|---:|
| 2560×1440 a 60 FPS | 3.686.400 | 221.184.000 |
| 3840×2160 a 60 FPS | 8.294.400 | 497.664.000 |

4K60 movimenta 2,25 vezes o número de pixels de 1440p60. O bitrate necessário depende do conteúdo, codec, implementação e qualidade desejada.

Para um transmissor e quatro espectadores, supondo um fluxo de bitrate B, sem camadas adicionais e desconsiderando overhead:

| Topologia | Upload do transmissor | Tráfego de mídia no servidor |
|---|---:|---|
| Mesh direto | Aproximadamente 4B | Axum não transporta mídia |
| Mesh via TURN | Aproximadamente 4B | Relay encaminha os fluxos que o utilizarem |
| SFU | Aproximadamente B | Aproximadamente B de entrada e 4B de saída |

Simulcast pode aumentar o upload acima de uma única codificação. Também não se deve presumir que quatro peers impliquem exatamente quatro encoders independentes: isso precisa ser observado na implementação do navegador.

maxBitrate é um teto, sem garantia de qualidade ou vazão. A futura implementação precisará negociar codecs suportados, controlar parâmetros de envio e verificar a resolução/FPS recebidos. replaceTrack também não substitui a criação de um sender de vídeo quando o existente é de áudio. Especificação WebRTC.

Não há evidência neste repositório de suporte validado a 1440p60 ou 4K60 em qualquer navegador ou hardware.

11. Riscos para uma VPS barata

A quantidade de participantes por sala não define sozinha o custo: também importam salas simultâneas, conexões totais, persistência e relay.

Os riscos principais são:

- Banda de mídia: com SFU ou TURN, tráfego sustentado pode determinar o custo antes da CPU.
- Disco e SQLite: crescimento sem retenção, WAL, backups e espaço livre precisam de acompanhamento.
- Contenção global: armazenamento lento pode afetar o controle de todas as salas pelo lock identificado.
- Recuperação operacional: não há provisionamento de backup/restauração, supervisão ou configuração de produção no repositório inspecionado.
- Rede RTC: TURN/SFU exigem conectividade própria de mídia; o túnel HTTP atual não comprova essa infraestrutura.
- Disponibilidade: presença continua restrita a uma instância. Uma reinicialização desfaz as salas ativas em memória.

Para produção, a arquitetura deve servir o build estático e encaminhar API/WS por HTTPS, com cookie Secure e origem explícita. O backend atual não serve arquivos estáticos. Isso é preparação de implantação, sem necessidade de transformar o domínio de negócio em microserviços.

12. Recomendação: híbrida na transição, SFU para tela

| Opção | Avaliação |
|---|---|
| Mesh para tudo | Mantém operação simples e evita tráfego de mídia na VPS quando há conexão direta. O upload do transmissor e a variabilidade dos dispositivos dificultam a meta de quatro espectadores em alta qualidade. |
| SFU para tudo | Uniformiza publicação e assinatura, reduz multiplicação do upload e centraliza controle de mídia. Exige integração e operação adicionais, incluindo banda e segurança. |
| Híbrida na transição | Preserva a voz atual e introduz compartilhamento de tela com publicação/assinatura próprias em SFU. Reduz o alcance inicial da migração, ao custo de operar dois caminhos de mídia. |

Recomendo a terceira opção como evolução inicial, com possível convergência posterior da voz para SFU se os testes mostrarem vantagem.

Uma SFU encaminha fluxos e pode selecionar camadas sem necessariamente transcodificar. Isso evita projetar uma VPS pequena para recodificar 4K60, mas não garante baixo consumo de banda nem resolve limitações do encoder do cliente. Visão geral de SFU.

O monólito Rust pode permanecer responsável por sessões, salas, autorização e persistência. A SFU acrescentaria o plano de mídia. A escolha de implementação deve depender de uma prova de capacidade e integração; não há evidência para selecionar um produto ou tamanho de VPS agora.

13. Ordem recomendada das melhorias

1. Corrigir contenção e admissão global: A1 e A3.
2. Preparar exposição pública: quotas, backup/restauração, HTTPS, supervisão e controles TURN: A4.
3. Estruturar publicações/assinaturas e ciclos de vida independentes: A2.
4. Fortalecer cancelamento, recuperação e renovação ICE: A5 e A6.
5. Instrumentar qualidade e operação: A9.
6. Validar SFU com um transmissor e quatro espectadores.
7. Aplicar retenção, paginação e limites de memória: A7 e A8.
8. Corrigir o controle dos timers de mensagens: A10.

14. Evidências existentes e medições pendentes

A leitura dos testes encontrou cobertura para concorrência de entrada, limite de cinco sessões, troca de aba, isolamento, mensagens idempotentes e autorização de sinalização. Exemplos: concorrência (apps/backend/tests/mvp.rs:302) e sinalização (apps/backend/tests/mvp.rs:570).

Os E2E incluem WebRTC nativo entre contextos Chromium, energia de áudio recebida, mute e liberação de recursos, inclusive quatro peers remotos por participante. A entrada de áudio é sintética. Teste de cinco participantes (e2e/mvp.spec.ts:179), teste de voz (e2e/mvp.spec.ts:360).

Esses testes foram inspecionados, não executados nesta auditoria. Não fornecem evidência de vídeo, desempenho WAN, TURN real ou compatibilidade ampla.

Antes de definir compromisso de qualidade e infraestrutura, faltam medir:

- Resolução/FPS de captura, codificação, recepção e apresentação.
- Bitrate, retransmissões, perda, RTT, jitter e congelamentos.
- CPU/GPU, encoder utilizado, memória e degradação térmica.
- Um versus quatro espectadores, incluindo um espectador com rede limitada.
- Conteúdo estático/texto versus movimento intenso.
- Chrome, Firefox e Safari nos sistemas operacionais pretendidos.
- Candidate pair selecionado, uso real de TURN e recuperação em troca de rede.
- Chamadas longas, renovação ICE e repetidos ciclos de compartilhar/parar.
- Latência de espera do Hub, consultas SQLite, filas WS e consumo em múltiplas salas.
- Banda e custo de saída da VPS na carga sustentada pretendida.

A fundação atual pode ser preservada. A decisão que precisa mudar antes da tela é tratar mídia como publicações independentes, com autorização, assinatura, ciclo de vida e qualidade observável.
