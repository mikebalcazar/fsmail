-- La bitácora del cartero: cada webhook que llega queda anotado con lo que
-- se hizo y por qué. Sin esto, un correo que no aparece es un misterio (se
-- vivió el 22-oct-2026 en la primera prueba real).
CREATE TABLE IF NOT EXISTS bitacora (
  id         TEXT PRIMARY KEY,
  cuando     TEXT NOT NULL,
  origen     TEXT NOT NULL,            -- 'webhook' | 'cron'
  tipo       TEXT,                     -- email.received, …
  referencia TEXT,                     -- email_id de Resend
  resultado  TEXT NOT NULL,            -- ok | ignorado | firma_invalida | json_invalido | error
  detalle    TEXT,                     -- JSON con guardados/motivo, o el mensaje de error
  ms         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bitacora_cuando ON bitacora(cuando);
