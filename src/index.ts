/* FSMAIL · el Worker. Un solo origen: la interfaz en /, la API en /api, el
 * webhook de Resend en /webhook/resend. */

import { Hono } from 'hono';
import type { Env, Variables } from './entorno';
import { conSesion, err, publica, rutasAuth } from './auth';
import { refrescarPendientes, rutasDominios } from './dominios';
import { rutasMensajes } from './bandejas';
import { rutasWebhook } from './webhook';
import { rutasPush } from './push';
import { generarPendientes, rutasAsistente } from './asistente';
import UI from './ui.html';
import SW from './sw.js';
import ICONO_96 from './icono-96.png';
import ICONO_192 from './icono-192.png';
import ICONO_512 from './icono-512.png';
import ICONO_MASK from './icono-maskable-512.png';
import BADGE_96 from './badge-96.png';
import LOGO_SVG from './marca/fsmail.svg';

export const VERSION = '0.2.0';
type App = { Bindings: Env; Variables: Variables };
const app = new Hono<App>();

app.onError((e, c) => {
  console.error('fsmail', c.req.method, c.req.path, e instanceof Error ? e.stack ?? e.message : String(e));
  return c.json({ ok: false, error: 'falla_interna' }, 500);
});

/** FSMAIL es una app privada: nada de ella va a buscadores. Google la
 *  rastreaba (rutas sacadas del JS, todas con la misma pantalla de entrada)
 *  y Search Console de forespot.com marcaba duplicados, 404 y 401. */
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Robots-Tag', 'noindex, nofollow');
});
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n', 200, { 'Cache-Control': 'public, max-age=86400' }));

// `asistente` dice si el Worker tiene la llave de Anthropic (no la llave): así se comprueba el secreto sin leerlo.
app.get('/salud', (c) => c.json({ ok: true, app: 'fsmail', version: VERSION, entorno: c.env.ENTORNO, asistente: c.env.ANTHROPIC_API_KEY ? 'con_llave' : 'sin_llave' }));

/** El logo de la marca de un dominio, público: los clientes de correo lo
 *  piden sin sesión. Sólo existe si el dueño lo subió. */
app.get('/marca/:dominio_id/logo', async (c) => {
  const obj = await c.env.CORREO.get(`marca/${c.req.param('dominio_id')}/logo`);
  if (!obj) return c.text('no hay logo', 404);
  return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType ?? 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
});
app.route('/webhook', rutasWebhook);

/** PWA y notificaciones: el service worker, el manifiesto y los íconos. */
app.get('/sw.js', (c) => c.body(SW, 200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }));
app.get('/manifest.webmanifest', (c) => c.body(JSON.stringify({
  name: 'FSMAIL', short_name: 'FSMAIL', description: 'Correo para tus dominios', start_url: '/', scope: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#6c5ce7', lang: 'es',
  icons: [{ src: '/icono-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icono-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icono-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }, { src: '/logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
}), 200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' }));
const icono = (bytes: ArrayBuffer) => new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800, immutable' } });
app.get('/icono-96.png', () => icono(ICONO_96));
app.get('/icono-192.png', () => icono(ICONO_192));
app.get('/icono-512.png', () => icono(ICONO_512));
app.get('/icono-maskable-512.png', () => icono(ICONO_MASK));
app.get('/badge-96.png', () => icono(BADGE_96));
app.get('/logo.svg', (c) => c.body(LOGO_SVG, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=604800, immutable' }));

const api = new Hono<App>();
api.route('/auth', rutasAuth);
api.use('/yo', conSesion);
api.get('/yo', (c) => c.json({ ok: true, cuenta: publica(c.get('cuenta')), version: VERSION }));
api.use('/dominios/*', conSesion);
api.use('/dominios', conSesion);
api.route('/dominios', rutasDominios);
api.use('/mensajes/*', conSesion);
api.use('/mensajes', conSesion);
api.route('/mensajes', rutasMensajes);
api.use('/push/*', conSesion);
api.route('/push', rutasPush);
api.use('/asistente/*', conSesion);
api.route('/asistente', rutasAsistente);
api.all('*', (c) => err(c, 'no_existe', 404));
app.route('/api', api);

app.get('/', (c) => c.html(UI));
app.get('*', (c) => c.html(UI));

export default {
  fetch: app.fetch,
  /** El cron de wrangler.toml: dominios pendientes → preguntar a Resend;
   *  sugerencias del asistente que quedaron sin redactar → redactarlas. */
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(refrescarPendientes(env).then((r) => console.log('cron dominios', JSON.stringify(r))));
    ctx.waitUntil(generarPendientes(env).then((r) => console.log('cron asistente', JSON.stringify(r))).catch((e) => console.error('cron asistente', String(e))));
  },
};
