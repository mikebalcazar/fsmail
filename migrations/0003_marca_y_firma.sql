-- Marca por dominio (logo, sitio, color, nombre comercial) y firma por
-- dirección (nombre, puesto, teléfono). Mike, 23-oct-2026: «cuando agregue
-- un mail llene un mini formulario de nombre, puesto, teléfono y se genere
-- un banner de firma con hiperligas». JSON en texto, como los registros.
ALTER TABLE dominios ADD COLUMN marca TEXT NOT NULL DEFAULT '{}';
ALTER TABLE direcciones ADD COLUMN firma TEXT NOT NULL DEFAULT '{}';
