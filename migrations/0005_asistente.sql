-- Asistente de respuestas (Mike, 26-oct-2026, con botones: «Borrador para
-- aprobar»). Por dirección: si está activo, cada correo que llega a esa
-- dirección produce una respuesta SUGERIDA que una persona revisa y envía.
-- Nunca se envía solo.

CREATE TABLE IF NOT EXISTS asistentes (
  direccion_id   TEXT PRIMARY KEY REFERENCES direcciones(id),
  activo         INTEGER NOT NULL DEFAULT 0,
  modo           TEXT NOT NULL DEFAULT 'borrador',  -- por ahora sólo 'borrador'
  instrucciones  TEXT NOT NULL DEFAULT '',          -- tono y reglas propias del negocio
  conocimiento   TEXT NOT NULL DEFAULT '',          -- base de conocimiento (precios, FAQ, guías)
  fuente_url     TEXT,                              -- de dónde se importa (p. ej. https://vigifield.com/llms.txt)
  actualizado_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sugerencias (
  id             TEXT PRIMARY KEY,
  cuenta_id      TEXT NOT NULL,
  mensaje_id     TEXT NOT NULL UNIQUE,              -- el correo que llegó
  hilo_id        TEXT NOT NULL,
  direccion_id   TEXT NOT NULL,
  estado         TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | lista | enviada | descartada | error
  categoria      TEXT,                              -- duda | venta | soporte | cobro | cancelacion | queja | legal | spam | otro
  humano         INTEGER NOT NULL DEFAULT 0,        -- 1 = tema delicado: lo revisa una persona con cuidado
  motivo         TEXT,
  texto          TEXT,
  modelo         TEXT,
  intentos       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  creada_at      TEXT NOT NULL,
  actualizada_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sugerencias_estado ON sugerencias(estado, creada_at);
CREATE INDEX IF NOT EXISTS idx_sugerencias_hilo ON sugerencias(cuenta_id, hilo_id, creada_at);
