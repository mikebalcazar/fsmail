-- Conector para Claude (Mike, 04-nov-2026, con botones: «leer y actuar»).
-- FSMAIL hace de servidor OAuth 2.1 para clientes MCP: registro dinámico
-- de clientes, códigos de autorización con PKCE y tokens. De cada código y
-- token sólo se guarda el hash.

CREATE TABLE IF NOT EXISTS oauth_clientes (
  id              TEXT PRIMARY KEY,
  nombre          TEXT,
  redirect_uris   TEXT NOT NULL,          -- JSON [url]
  metodo_auth     TEXT NOT NULL,          -- none | client_secret_post | client_secret_basic
  secreto_hash    TEXT,                   -- sólo si el cliente no es público
  creado_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codigos (
  hash            TEXT PRIMARY KEY,
  cliente_id      TEXT NOT NULL,
  cuenta_id       TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  reto            TEXT NOT NULL,          -- code_challenge S256
  alcance         TEXT NOT NULL,
  recurso         TEXT,
  expira_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  hash            TEXT PRIMARY KEY,
  tipo            TEXT NOT NULL,          -- acceso | renovar
  cliente_id      TEXT NOT NULL,
  cuenta_id       TEXT NOT NULL,
  alcance         TEXT NOT NULL,
  recurso         TEXT,
  expira_at       TEXT NOT NULL,
  creado_at       TEXT NOT NULL,
  usado_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_cuenta ON oauth_tokens(cuenta_id, cliente_id);
