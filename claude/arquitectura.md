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

## Lo que falta de Mike (una cosa por vez, con botones cuando sea decisión)

1. **Secretos del repositorio `fsmail`** (Settings → Secrets → Actions):
   `CLOUDFLARE_API_TOKEN` (con Workers, D1, R2 y DNS de forespot.com),
   `CLOUDFLARE_ACCOUNT_ID`, `RESEND_API_KEY` (la de la suite),
   `RESEND_WEBHOOK_SECRET` (sale al crear el webhook, paso 3).
2. **El registro que falta en Cloudflare**: `plataforma CNAME
   forespot-plataforma.pages.dev` (proxied). Sin él,
   plataforma.forespot.com no existe desde el 22-oct.
3. **El webhook en Resend** (Webhooks → Add): URL
   `https://mailing.forespot.com/webhook/resend`, evento `email.received`.
   El signing secret `whsec_…` es `RESEND_WEBHOOK_SECRET`.
4. ~~Decisión: remitente de los correos propios~~ **Decidido el 22-oct
   (botones): `acceso@mailing.forespot.com`**, sobre `envios.taller101.mx` y
   sobre dejar `onboarding@resend.dev`. Consecuencia aceptada: ocupa 1
   dominio de la cuota de Resend (con `envios.taller101.mx` son 2 de 3 en
   Free). Lo hace solo el paso «remitente» del flujo
   (`scripts/remitente.mjs`): alta en Resend sólo para envío, registros
   DKIM/SPF en la zona forespot.com de Cloudflare, verificación. Mike no
   hace nada más que los secretos del punto 1.

## Fases

1. **Cimientos** (este repositorio, 22-oct-2026): lo de arriba.
2. **Vivir ahí**: borradores, varios destinatarios con CC/BCC en la interfaz,
   adjuntos al enviar, catch-all por dominio con su regla, paginación
   «cargar más», móvil medido con Playwright a 390×844.
3. **Después, cuando Mike lo pida**: filtro de spam propio, etiquetas,
   contactos, firmas por dirección, varios usuarios por cuenta.
