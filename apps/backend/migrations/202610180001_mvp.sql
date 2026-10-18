CREATE TABLE sessions (
    id TEXT PRIMARY KEY NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 2 AND 32),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE servers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 64),
    creator_id TEXT NOT NULL REFERENCES sessions(id),
    created_at INTEGER NOT NULL
);
CREATE INDEX servers_created ON servers(created_at, id);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    server_id TEXT NOT NULL REFERENCES servers(id),
    sender_id TEXT NOT NULL REFERENCES sessions(id),
    sender_name TEXT NOT NULL,
    content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
    created_at INTEGER NOT NULL,
    UNIQUE(sender_id, client_id)
);
CREATE INDEX messages_history ON messages(server_id, id DESC);
