-- FSMAIL · D1. Sólo el índice: quién es quién, qué dominios y direcciones
-- tiene, y la ficha de cada mensaje para listar y buscar. El mensaje completo
-- (HTML, texto, cabeceras, adjuntos) vive en R2, nunca aquí.
-- Fechas: TEXT ISO 8601 UTC.

CREATE TABLE IF NOT EXISTS cuentas (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,     -- a-z 0-9 . _ -  (3 a 32), minúsculas
  correo      TEXT NOT NULL UNIQUE,     -- correo de recuperación / entrada, minúsculas
  nombre      TEXT,
  creada_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS codigos (
  correo      TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  expira_at   TEXT NOT NULL,
  intentos    INTEGER NOT NULL DEFAULT 0,
  enviado_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sesiones (
  id_hash     TEXT PRIMARY KEY,         -- sha256 del valor de la cookie
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id),
  creada_at   TEXT NOT NULL,
  expira_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dominios (
  id            TEXT PRIMARY KEY,
  cuenta_id     TEXT NOT NULL REFERENCES cuentas(id),
  dominio       TEXT NOT NULL UNIQUE,   -- negocio.com, minúsculas
  resend_id     TEXT,
  estado        TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente | verificado | fallido
  registros     TEXT NOT NULL DEFAULT '[]',          -- JSON: lo que el dueño pone en su DNS
  catch_all     INTEGER NOT NULL DEFAULT 0,
  creada_at     TEXT NOT NULL,
  verificada_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dominios_cuenta ON dominios(cuenta_id);

CREATE TABLE IF NOT EXISTS direcciones (
  id          TEXT PRIMARY KEY,
  dominio_id  TEXT NOT NULL REFERENCES dominios(id),
  local       TEXT NOT NULL,            -- 'ventas' de ventas@negocio.com, minúsculas
  nombre      TEXT,                     -- 'Ventas Negocio' (el nombre con que sale)
  activa      INTEGER NOT NULL DEFAULT 1,
  creada_at   TEXT NOT NULL,
  UNIQUE (dominio_id, local)
);

CREATE TABLE IF NOT EXISTS hilos (
  id          TEXT PRIMARY KEY,
  cuenta_id   TEXT NOT NULL,
  asunto      TEXT,
  ultimo_at   TEXT NOT NULL,
  mensajes    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mensajes (
  id             TEXT PRIMARY KEY,
  cuenta_id      TEXT NOT NULL,
  dominio_id     TEXT NOT NULL,
  direccion_id   TEXT,                  -- NULL = llegó a una dirección no dada de alta (catch-all o «sin dirección»)
  hilo_id        TEXT NOT NULL,
  resend_id      TEXT UNIQUE,           -- id del correo en Resend (recibido o enviado)
  message_id     TEXT,                  -- cabecera Message-ID
  en_respuesta_a TEXT,                  -- cabecera In-Reply-To
  de             TEXT NOT NULL,
  de_nombre      TEXT,
  para           TEXT NOT NULL,         -- JSON [direcciones]
  asunto         TEXT,
  resumen        TEXT,                  -- primeros ~160 caracteres del texto
  fecha          TEXT NOT NULL,
  carpeta        TEXT NOT NULL DEFAULT 'entrada',  -- entrada | enviados | archivo | basura
  leido          INTEGER NOT NULL DEFAULT 0,
  adjuntos       INTEGER NOT NULL DEFAULT 0,
  r2_llave       TEXT NOT NULL,
  tamano         INTEGER,
  autenticacion  TEXT,                  -- JSON {spf,dkim,dmarc} tal como lo reporta Resend
  creada_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mensajes_bandeja ON mensajes(cuenta_id, dominio_id, direccion_id, carpeta, fecha);
CREATE INDEX IF NOT EXISTS idx_mensajes_hilo ON mensajes(hilo_id, fecha);
CREATE INDEX IF NOT EXISTS idx_mensajes_message_id ON mensajes(cuenta_id, message_id);

CREATE TABLE IF NOT EXISTS adjuntos (
  id          TEXT PRIMARY KEY,
  mensaje_id  TEXT NOT NULL REFERENCES mensajes(id),
  nombre      TEXT,
  tipo        TEXT,
  tamano      INTEGER,
  content_id  TEXT,
  inline      INTEGER NOT NULL DEFAULT 0,
  r2_llave    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adjuntos_mensaje ON adjuntos(mensaje_id);
