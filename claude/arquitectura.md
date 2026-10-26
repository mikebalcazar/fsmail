# FSMAIL: qué se decidió y cómo se arma

FSMAIL es la plataforma de correo de Forespot: un usuario administra varios
dominios y, dentro de cada dominio, varias direcciones; las bandejas se
separan solas por dominio y por dirección. Sirve sobre todo para atención a
clientes de los negocios cuyos dominios se agregan. **Es una marca y una app
independientes de suite101** (Mike, 17-oct-2026).

## Decisiones de Mike (todas con botones)

| Fecha | Decisión | Consecuencia dicha antes |
|---|---|---|
| 17-oct | Producto nuevo: registro público con username; dentro se ligan dominios y direcciones para recibir y enviar. No Gmail Business. | — |
| 17-oct | Repositorio nuevo `fsmail`, Worker + D1 + R2 propios. | Nada de suite101. |
| 17-oct | Cartero: **Resend, la cuenta existente** de la suite. Reconfirmado tras declarar la independencia: es el único lazo. | Cuota (enviados + recibidos) y tope de dominios compartidos con `envios.taller101.mx`: Free = 3 dominios → 2 negocios gratis; Pro 20 USD = 10; Scale 90 USD = 1,000. Reputación compartida. La misma llave en dos Workers. |
| 17-oct | Dirección: **mailing.forespot.com** (sobre fsmail.com y «ambas»). | Si se vende a terceros entran por una URL de Forespot hasta agregar otro dominio como alias. |
| 17-oct | **Nada que ver con suite101.** Se descartó colgarlo de la puerta y de `empresas.suite101.app`. | — |
| 22-oct | Remitente de los correos propios: **acceso@mailing.forespot.com** (sobre envios.taller101.mx y onboarding@resend.dev). | Ocupa 1 dominio de la cuota de Resend. |
| 26-oct | **Asistente de respuestas** dentro de FSMAIL (el buzón de atención de contacto@vigifield.com ya llega aquí), en modo **«Borrador para aprobar»** (sobre «automático con excepciones» y «automático total»). | Nada sale sin que una persona pulse Enviar; costo por correo de la API de Anthropic; necesita el secreto `ANTHROPIC_API_KEY`. |
| 17-oct | El DNS de **forespot.com se muda a Cloudflare** para que mailing.forespot.com sea dominio directo del Worker (sobre zona nueva fsmail.com con SaaS, y sobre sólo fsmail.com). | Cambio de NS, copiar registros, propagación. **Hecho el 22-oct**: NS `leah/remy.ns.cloudflare.com`; 13 de 14 registros medidos iguales; faltó `plataforma` (ver pendientes). Gmail de forespot.com intacto. |

Preguntas que Mike hizo antes de decidir el cartero, para no repetirlas:
*¿Para qué es Resend?* FSMAIL es el cliente; Resend es el cartero SMTP.
*¿Por qué no un SMTP propio?* Workers no escuchan puertos y Cloudflare bloquea
el 25 de salida; un VPS trae IP sin reputación, puerto 25 por desbloquear,
operación 24/7 y el riesgo de que un negocio abusivo tumbe a todos.
*¿Costo con la cuenta existente?* La tabla de arriba.

## Cómo se arma

```
negocio.com ──MX──▶ Resend (recibe; revisa SPF/DKIM/DMARC del remitente)
                      │ webhook email.received (firma svix)
                      ▼
               Worker fsmail ── GET /emails/receiving/{id} + adjuntos
                      │           guarda JSON + adjuntos en R2
                      │           indexa en D1: cuenta → dominio → dirección → hilo
                      ▼
          mailing.forespot.com ── bandejas por dominio y dirección
                      └── enviar / responder: POST /emails con el dominio del negocio
```

- **Un Worker** (`fsmail`; staging `fsmail-staging`), **un D1** (`fsmail`),
  **un R2** (`fsmail-correo`). Hono, TypeScript, sin framework de interfaz:
  `src/ui.html` es una página sola.
- **Cuentas** (`src/auth.ts`): username + correo de recuperación; se entra con
  un código de 6 dígitos al correo; cookie `fsm` HttpOnly, su valor sólo
  existe hasheado en D1. Fuera de producción el código viaja en la respuesta
  y Resend no se llama.
- **Dominios** (`src/dominios.ts`): `POST /domains` en Resend con
  `capabilities.receiving = enabled`; los registros que devuelve (DKIM, SPF
  del retorno, MX de recepción) se le enseñan al dueño para SU DNS. «Revisar
  DNS» pide la verificación y relee el estado. Nunca se le pide mover su DNS.
- **Direcciones**: `ventas@`, `info@`… por dominio, con nombre con el que
  salen. Lo que llega a una dirección no dada de alta se guarda como «sin
  dirección» en el dominio; al crear la dirección se le asigna.
- **Entrada** (`src/webhook.ts`): se contesta 2xx sólo con todo guardado; con
  5xx Resend reintenta. Idempotente por `resend_id`. Hilos por
  `In-Reply-To`/`References` contra los `Message-ID` de la cuenta.
- **Bandejas** (`src/bandejas.ts`): conteos por dominio y dirección, lista
  con búsqueda (asunto, remitente, resumen), lectura (HTML en iframe
  `sandbox`), carpetas entrada/enviados/archivo/basura, adjuntos desde R2.
- **Envío**: desde una dirección de un dominio **verificado**, firmado con el
  DKIM del dominio del negocio; responder lleva `In-Reply-To` y `References`
  y se queda en el hilo.
- **El cartero** (`src/cartero.ts`) es el único que habla con Resend. Si un
  día se cambia de proveedor, se cambia ahí.

## Modelo de datos (`migrations/0001_fsmail.sql`)

`cuentas`, `codigos`, `sesiones`, `dominios` (con los registros DNS en
JSON), `direcciones`, `hilos`, `mensajes` (la ficha: de, para, asunto,
resumen, fecha, carpeta, leído, llave de R2, autenticación), `adjuntos`.
R2: `c/<cuenta>/m/<mensaje>.json` y `c/<cuenta>/m/<mensaje>/a/<adjunto>`.

## Lo que se midió

- 23 pruebas en workerd (`pruebas/`): registro y entrada; alta, verificación
  y direcciones de dominios con Resend de mentira; webhook con firma válida,
  inválida y vieja; mensaje a dirección dada de alta (R2, conteos, lectura,
  adjunto, duplicado); «sin dirección» y reasignación; dominio ajeno; hilos y
  búsqueda; enviar y responder con cabeceras; mover de carpeta.
- No se midió todavía con Resend de verdad: hace falta la llave en el Worker.

## Publicado (22-oct-2026, run 39723659938)

- Producción: https://mailing.forespot.com (dominio propio del Worker) y
  https://fsmail.mike-929.workers.dev. Staging:
  https://fsmail-staging.mike-929.workers.dev. `/salud` 200 e interfaz en los
  dos; lo mide `verificar` y lo deja como comentario del commit.
- D1 `fsmail` y `fsmail-staging`, R2 `fsmail-correo` y `fsmail-correo-staging`
  creados por el flujo. Migración 0001 aplicada en los dos.
- Remitente `mailing.forespot.com` dado de alta en Resend (sólo envío) con sus
  4 registros en la zona forespot.com. Estado en Resend: `pending` al
  cierre; cada run lo vuelve a verificar.
- Dos tropiezos del día, ya corregidos (#2, #3): el comentario de
  wrangler.toml también decía PENDIENTE; Resend da los nombres DNS relativos
  a la zona, no al dominio (se crearon y luego se borraron 4 registros
  doblados); el comentario del commit llevaba acentos graves en el shell.

## Lo que falta de Mike (una cosa por vez, con botones cuando sea decisión)

1. ~~Secretos de Cloudflare y Resend~~ Puestos el 22-oct. Falta uno:
   `RESEND_WEBHOOK_SECRET` (sale del paso 3).
2. ~~CNAME `plataforma`~~ Puesto el 22-oct; plataforma.forespot.com responde 200.
3. ~~El webhook en Resend~~ Puesto el 22-oct (run 39724081694); el
   remitente quedó `verified`.
4. ~~Primera prueba real con `pruebas.forespot.com`~~ Hecha y medida
   (22 y 23-oct): recepción con adjunto, envío, respuesta en el mismo hilo
   de Gmail, contestación de vuelta en FSMAIL. Dominio quitado el 23-oct
   con el flujo `quitar-dominio.yml` (Resend, 4 DNS, 6 objetos R2, D1).
4. ~~Decisión: remitente de los correos propios~~ **Decidido el 22-oct
   (botones): `acceso@mailing.forespot.com`**, sobre `envios.taller101.mx` y
   sobre dejar `onboarding@resend.dev`. Consecuencia aceptada: ocupa 1
   dominio de la cuota de Resend (con `envios.taller101.mx` son 2 de 3 en
   Free). Lo hace solo el paso «remitente» del flujo
   (`scripts/remitente.mjs`): alta en Resend sólo para envío, registros
   DKIM/SPF en la zona forespot.com de Cloudflare, verificación. Mike no
   hace nada más que los secretos del punto 1.

## Lo aprendido en la primera prueba real (22-oct-2026)

- Pedir la verificación a Resend (`POST /domains/{id}/verify`) reinicia su
  revisión y deja todo en `pending`: el cron sólo la pide si hay registros
  `not_started`/`failed`; si están `pending`, sólo lee.
- Sin bitácora no se sabe qué eslabón falla: `bitacora` en D1 anota cada
  webhook y cada pasada del cron.
- Un dominio que ya está en la cuenta de Resend (las plataformas mandan
  avisos con él) se reusa con `capabilities.receiving = enabled`; mandar no
  cambia.
- Resend entrega los nombres DNS relativos a la **zona**, no al dominio.

## Marca y firma (23-oct-2026)

Mike: «cuando agregue un mail llene un mini formulario de nombre, puesto,
teléfono y se genere un banner de firma con hiperligas». `dominios.marca`
(nombre comercial, sitio, color, logo en R2 bajo `marca/<dominio_id>/logo`,
servido público en `/marca/:dominio_id/logo` porque los clientes de correo
lo piden sin sesión) y `direcciones.firma` (nombre, puesto, teléfono,
renglón extra). `src/firma.ts` arma el banner: tabla con estilos en línea;
logo → sitio, nombre → `mailto:`, teléfono → `wa.me` (10 dígitos se toman
como México), sitio como liga; y la versión en texto. Al enviar o responder
se pega en HTML (el texto plano se vuelve párrafos) y en texto. Todo lo del
usuario va escapado; el sitio sólo acepta http(s).

## Interfaz (23-oct-2026, segunda vuelta)

Mike vio la primera versión y pidió: pantalla blanca sin marco; barra
lateral gris **flotando** como vidrio con sombra debajo; despliegue de las
direcciones de arriba hacia abajo, rápido y con aceleración; botón de
refrescar; «Redactar» grande; adjuntar archivos al redactar; íconos para
borrar, archivar, marcar no leído. Cómo quedó: fondo blanco con manchas de
color suaves detrás (`#app::before`, a la deriva lenta) para que el vidrio
tenga algo que difuminar; `#arbol` con margen, radio 24, `backdrop-filter`
y sombra larga; el acordeón lo anima el guion con la Web Animations API
(`desplegar`: altura 0 → real en 260 ms con `cubic-bezier(.2,.8,.2,1)` y
cada hijo entra escalonado 32 ms desde arriba; al cerrar, salida en 200 ms
con aceleración); refrescar a mano (botón que gira, avisa cuántos nuevos) y
solo cada 60 s con la pestaña visible y sin diálogo abierto; acciones con
íconos en el lector y al pasar el cursor sobre cada fila (la fila se va
deslizando al archivar o tirar). Adjuntos: el navegador los lee en base64
y van en el JSON de `/mensajes/enviar` (`adjuntos: [{nombre, tipo,
contenido}]`), el Worker los valida (10 archivos, 20 MB en total, por
debajo de los 40 MB de Resend), los manda a Resend como `attachments` y
los guarda en R2 y en `adjuntos` para verlos en «enviados». Medido con
`pruebas/interfaz.mjs` (Chromium, API simulada, 1440 y 390): sin errores
de página y el envío llevó los 2 adjuntos.

## Notificaciones push (24-oct-2026, decisión con botones)

Mike preguntó cómo tener notificaciones, al menos en escritorio. Opciones:
Web Push real (recomendada), sólo con la pestaña abierta, o las dos por
etapas. Eligió **Web Push real**. Sin librerías: `src/push.ts` cifra el
aviso (RFC 8291, aes128gcm: ECDH efímero + `auth` del navegador → HKDF →
AES-128-GCM, un registro de 4096), firma VAPID (RFC 8292: JWT ES256 con
`aud` = origen del endpoint, 12 h, `sub` = mailto del remitente) y hace el
POST al servicio del navegador (RFC 8030) con `TTL 86400`. Las llaves
VAPID son un par por instalación: las genera el Worker la primera vez y
viven en D1 (`vapid`, una fila); nadie las maneja a mano ni pasan por el
chat. Suscripciones en `push_suscripciones` (una por navegador, `endpoint`
único; 404/410 la borra). El webhook, al guardar un correo, avisa a los
navegadores de la cuenta antes de contestar a Resend (nunca tira el
webhook; queda en la bitácora como `push`). PWA: `/sw.js` (sólo push, no
cachea), `/manifest.webmanifest`, íconos PNG generados (96/192/512) que
viajan dentro del Worker como `Data`. Interfaz: campana en el pie de la
barra → permiso → suscripción → alta → notificación de prueba; diálogo con
los navegadores suscritos, «Enviar prueba» y «Apagar». Tocar la
notificación abre el correo (`#m=<id>`, o mensaje al service worker si la
pestaña ya está abierta). Probado: lo que cifra el Worker lo descifra un
«navegador» de mentira en la prueba; el JWT se verifica con la clave
pública anunciada; 410 borra la suscripción.

## Asistente de respuestas (26-oct-2026, decisión con botones)

- **Por dirección** (`asistentes`, migración 0005): activo, base de
  conocimiento (≤60,000 caracteres; se puede importar de una URL https de
  texto o HTML ≤300 KB, p. ej. `https://vigifield.com/llms.txt`),
  instrucciones de tono (≤2,000) y modo (`borrador`, el único por ahora).
- **Por correo** (`sugerencias`): el webhook, tras guardar, encola una fila
  `pendiente` si la dirección tiene asistente activo y el correo no es
  automático (no-reply, mailer-daemon, `List-Id`/`List-Unsubscribe`,
  `Auto-Submitted`, `Precedence: bulk`) ni de un dominio de la misma cuenta.
  Se redacta en segundo plano (`waitUntil`) y el cron de 10 min retoma las
  pendientes y las que se quedaron `redactando` más de 5 min. Fallas de red,
  429 y 5xx se reintentan hasta 3 veces; llave inválida o ausente, no.
- **Llamada**: `POST {ANTHROPIC_BASE}/v1/messages`, modelo `ASISTENTE_MODELO`
  (wrangler.toml), `system` = reglas + instrucciones + `<conocimiento>` con
  `cache_control` (la base se cobra barata en cada correo), `user` = los
  últimos 8 mensajes del hilo en `<hilo>` (sin citas ni HTML). Sale JSON:
  categoría, requiere_humano, motivo, respuesta. Cobro, cancelación, queja y
  legal fuerzan «requiere persona». Cada redacción se anota en la bitácora
  (`origen = 'asistente'`, con el uso de tokens).
- **API** (`/api/asistente`, con sesión y dueño por cuenta):
  `GET|PUT /direcciones/:id`, `POST /direcciones/:id/importar`,
  `GET /mensajes/:id` (sugerencia vigente del hilo y si hay asistente),
  `POST /mensajes/:id/sugerir` (redacta en el momento; también sirve para
  correos viejos), `POST /sugerencias/:id/descartar|usada`.
- **Interfaz**: ficha del dominio → botón «Asistente» por dirección. Al abrir
  un correo, la sugerencia aparece arriba de la caja de responder y la llena
  si está vacía; aviso «Requiere persona» en naranja; Regenerar / Descartar.
  Al enviar, la sugerencia queda `enviada`.
- **Secreto** `ANTHROPIC_API_KEY`: lo pone el flujo desde los secretos del
  repo, como los de Resend. `/salud` dice `asistente: con_llave|sin_llave`.

## Fases

1. **Cimientos** (este repositorio, 22-oct-2026): lo de arriba.
2. **Vivir ahí**: borradores, varios destinatarios con CC/BCC en la interfaz,
   ~~adjuntos al enviar~~ (hecho 23-oct), catch-all por dominio con su regla, paginación
   «cargar más», móvil medido con Playwright a 390×844.
3. **Después, cuando Mike lo pida**: filtro de spam propio, etiquetas,
   contactos, firmas por dirección, varios usuarios por cuenta.
