# Migrations SQLx

`202610180001_mvp.sql` cria `sessions`, `servers`, `messages` e seus índices.
O SQLx mantém `_sqlx_migrations` para versões/checksums. `sqlx::migrate!` incorpora
os arquivos no binário e `build.rs` observa mudanças neste diretório.
A inicialização aplica migrations antes de abrir a porta HTTP; falhas interrompem
esse processo. Não é necessário SQLx CLI nem banco ativo para compilar.

Para criar outra migration, instale opcionalmente o CLI e execute na raiz:

```sh
cargo install sqlx-cli --version 0.8.6 --locked --no-default-features --features sqlite
sqlx migrate add --source apps/backend/migrations nome_da_alteracao
```

Edite o SQL gerado, teste num SQLite temporário e execute
`cargo run -p discord-backend --locked` para recompilar/aplicar. Para aplicar
manualmente: `sqlx migrate run --source apps/backend/migrations`, com
`DATABASE_URL` na `.env` da raiz ou exportada.

Nunca altere uma migration já aplicada. Crie outra migration para evoluir o
esquema e faça backup antes de migrações em bancos com dados importantes.
