-- Web Push: un par de llaves VAPID por instalación (lo genera el Worker la
-- primera vez) y las suscripciones de cada cuenta, una por navegador.
CREATE TABLE IF NOT EXISTS vapid (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  publica    TEXT NOT NULL,                 -- llave pública P-256 sin comprimir, base64url (65 bytes)
  privada    TEXT NOT NULL,                 -- JWK de la privada
  creada_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_suscripciones (
  id           TEXT PRIMARY KEY,
  cuenta_id    TEXT NOT NULL REFERENCES cuentas(id),
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  agente       TEXT,                        -- navegador, informativo
  creada_at    TEXT NOT NULL,
  ultimo_envio TEXT,
  ultimo_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_cuenta ON push_suscripciones(cuenta_id);
