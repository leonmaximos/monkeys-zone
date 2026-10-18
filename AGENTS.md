# Convenções para desenvolvimento

## Escopo e preservação

- Leia `README.md` e `docs/architecture.md` antes de alterar a arquitetura.
- Inspecione os arquivos existentes. Preserve alterações e conteúdo do usuário;
  obtenha autorização antes de sobrescrever conteúdo preexistente conflitante.
- Não faça commits automaticamente.
- O escopo autorizado inclui sessões anônimas, servidores públicos, presença,
  texto persistente e voz WebRTC mesh. Não adicione contas com senha, convites,
  canais múltiplos, vídeo, uploads ou permissões administrativas.
- Não adicione microserviços, filas, cache externo, ORM adicional, monorepo runner,
  mocks complexos ou camadas genéricas sem uma necessidade concreta.

## Arquitetura

- Backend: monólito modular, uma aplicação Axum, runtime Tokio e SQLx/SQLite.
- `main.rs` compõe configuração, logging, banco e ciclo de vida; `http.rs` compõe
  rotas e middleware. Handlers ficam junto do seu domínio, como `health.rs`.
- Domínios atuais: `identity`, `servers`, `presence`, `messages`, `realtime` e
  `signaling`. Preserve a separação entre persistência, regras e transporte.
  Não crie módulos vazios ou traits sem uso antecipadamente.
- Frontend: React/TypeScript, Tailwind e componentes shadcn/ui locais.
  `components/ui/` contém primitivas; novas funcionalidades poderão ocupar
  `src/features/<dominio>/`. `lib/` contém apenas utilitários compartilhados reais.
- Zustand mantém sessão pública, sala, mensagens, pendências e conexão.
  Não armazene cookies/tokens nele ou no localStorage; este guarda só preferências.
- REST será usado para operações convencionais; WebSocket para eventos,
  presença e sinalização; WebRTC para mídia. Esses transportes futuros não
  devem conter as regras de domínio.
- O serviço `features/voice/mesh.ts` mantém mídia fora dos componentes. Preserve
  esse limite para uma futura SFU. Feche peers, tracks, timers e audio elements
  em saída, desconexão, troca de aba e desmontagem.
- Atualize os contratos em `docs/architecture.md` junto de qualquer mudança de API.

## Rust

- Use a toolchain fixada em `rust-toolchain.toml`, edition 2024 e código idiomático.
- Propague erros com `Result` e `?`; use erros tipados nas fronteiras dos módulos.
  `Box<dyn Error + Send + Sync>` é aceitável no bootstrap.
- `unwrap` e `expect` são proibidos pelo Clippy do workspace. Não silencie os
  lints para contornar falhas; trate o erro ou devolva `Result` também nos testes.
- Não use estado global mutável. Compartilhe recursos por estado Axum quando
  endpoints reais precisarem deles. Não adicione o pool ao router sem uso.
- Use Tracing estruturado e campos nomeados. Não registre segredos, áudio,
  corpos de mensagens ou URLs de conexão com credenciais.
- CORS usa lista explícita de origens; não use `Any` ou curinga. Amplie métodos
  apenas conforme os endpoints implementados. CORS não substitui autorização.
- SQL parametrizado; novas migrations em `apps/backend/migrations/`. Nunca altere
  uma migration já aplicada. O `build.rs` recompila o migrator ao mudar o diretório.

## TypeScript e UI

- TypeScript estrito; evite `any`, casts injustificados e asserções não nulas.
- Use componentes funcionais, HTML semântico e rótulos acessíveis.
- Alias `@/` aponta para `apps/frontend/src/` em TypeScript e Vite/Vitest.
- Preserve a configuração shadcn em `components.json`; adicione somente os
  componentes necessários. Revise dependências que um gerador queira instalar.
- Use Zustand somente quando houver estado compartilhado; mídia futura e
  conexões precisam de ciclo de vida explícito, sem efeitos durante renderização.
- Use a `.env` da raiz. Variáveis `VITE_*` são públicas, nunca armazenam segredos.
- Prettier formata TypeScript, CSS, JSON e Markdown. rustfmt formata Rust.

## Dependências e testes

- Justifique novas dependências pelo requisito atendido. Mantenha `Cargo.lock`
  e `package-lock.json` atualizados; não misture gerenciadores npm/pnpm/yarn.
- Prefira testes de contratos, regras e falhas observáveis. Evite testes que
  apenas reproduzem a implementação ou exigem mocks extensos.
- Testes unitários usam valores explícitos e SQLite em memória. O teste Rust de
  socket usa porta loopback efêmera; E2E reserva portas 3000/5173 e usa SQLite
  temporário. Não reutilize um banco do usuário. Não mute variáveis globais de
  ambiente em testes Rust concorrentes.
- Playwright cobre fluxos reais com contextos independentes. A entrada de áudio
  WAV é sintética somente nos testes; WebRTC, RTP e WebSocket são reais. Não
  confunda energia recebida no Chromium com validação física ou em redes externas.

## Comandos de validação

Execute na raiz, depois de `npm ci` e da instalação da toolchain Rust:

```sh
cargo fmt --all -- --check
cargo check --workspace --locked
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
npm run format:check
npm run lint
npm test
npm run build
npm run test:e2e
```

Para formatar: `cargo fmt --all` e `npm run format`.
Para executar: `cargo run -p discord-backend --locked` e `npm run dev`
em terminais distintos. O health deve responder `200` com `{"status":"ok"}` em
`http://127.0.0.1:3000/health`; o frontend abre em `http://127.0.0.1:5173`.

Relate comandos realmente executados, resultados e limitações. Nunca declare
testes aprovados quando não rodaram. Não adicione funcionalidades fora do escopo
para contornar uma limitação de infraestrutura.

## Sessões e protocolo v1

- Escritas HTTP e handshake WS exigem Origin permitido. HTTP CORS permite
  credenciais somente para origens explícitas. Nunca autentique por ID do cliente.
- Cookie HttpOnly/SameSite, Secure sob HTTPS; segredo TURN existe só no backend.
  A configuração ICE fornece credenciais de uma hora, sem segredo permanente.
- Uma sessão ocupa uma sala/vaga e uma conexão ativa. Nova aba assume a sessão;
  geração antiga não pode executar comandos nem desconectar a geração nova.
- Preserve entrada/capacidade atômica e a reserva de reconexão de 20 s. Presença
  em memória suporta uma instância; SQLite persiste sessões, servidores e texto.
- Mantenha contratos WS v1 em Rust, TypeScript e docs sincronizados. Mensagens
  têm UUID de cliente e ack após persistência; nunca confirme só pelo send().
- Valide sinalização entre dois participantes conectados à mesma voz. Não logue
  SDP, ICE, tokens ou credenciais. Não restaure microfone automaticamente.
- Execute os E2E com os serviços locais parados. Instale Chromium com
  `npx playwright install chromium`. O comando E2E também verifica seus tipos.
