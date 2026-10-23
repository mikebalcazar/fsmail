/* FSMAIL · el Worker. Un solo origen: la interfaz en /, la API en /api, el
 * webhook de Resend en /webhook/resend. */

import { Hono } from 'hono';
import type { Env, Variables } from './entorno';
import { conSesion, err, publica, rutasAuth } from './auth';
import { refrescarPendientes, rutasDominios } from './dominios';
import { rutasMensajes } from './bandejas';
import { rutasWebhook } from './webhook';
import UI from './ui.html';

export const VERSION = '0.1.0';
type App = { Bindings: Env; Variables: Variables };
const app = new Hono<App>();

app.onError((e, c) => {
  console.error('fsmail', c.req.method, c.req.path, e instanceof Error ? e.stack ?? e.message : String(e));
  return c.json({ ok: false, error: 'falla_interna' }, 500);
});

app.get('/salud', (c) => c.json({ ok: true, app: 'fsmail', version: VERSION, entorno: c.env.ENTORNO }));

/** El logo de la marca de un dominio, público: los clientes de correo lo
 *  piden sin sesión. Sólo existe si el dueño lo subió. */
app.get('/marca/:dominio_id/logo', async (c) => {
  const obj = await c.env.CORREO.get(`marca/${c.req.param('dominio_id')}/logo`);
  if (!obj) return c.text('no hay logo', 404);
  return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType ?? 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
});
app.route('/webhook', rutasWebhook);

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
api.all('*', (c) => err(c, 'no_existe', 404));
app.route('/api', api);

app.get('/', (c) => c.html(UI));
app.get('*', (c) => c.html(UI));

export default {
  fetch: app.fetch,
  /** El cron de wrangler.toml: dominios pendientes → preguntar a Resend. */
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(refrescarPendientes(env).then((r) => console.log('cron dominios', JSON.stringify(r))));
  },
};
