/* El conector de FSMAIL para Claude (y cualquier cliente MCP). Decisión de
 * Mike, 04-nov-2026, con botones: «leer y actuar».
 *
 * Dos piezas en el mismo Worker:
 *   · Servidor OAuth 2.1 (RFC 8414 metadatos, RFC 7591 registro dinámico,
 *     PKCE S256 obligatorio, RFC 9728 metadatos del recurso, RFC 7009
 *     revocación). Se autoriza con la sesión de FSMAIL de siempre (usuario
 *     y código al correo) y una pantalla de permiso.
 *   · Servidor MCP por HTTP («Streamable HTTP», sin estado) en /mcp con
 *     cinco herramientas que reusan la API de FSMAIL tal cual: mismas
 *     validaciones, firmas y adjuntos que la interfaz.
 *
 * Códigos y tokens sólo se guardan hasheados. El origen se toma de la
 * petición, así funciona igual en producción y en staging. */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Cuenta, Env, Variables } from './entorno';
import { ahora, enSegundos, esc, id, igualSeguro, sha256, tokenAleatorio, vencida } from './lib';
import { cuentaDeSesion, err } from './auth';
import { rutasDominios } from './dominios';
import { rutasMensajes } from './bandejas';

type App = { Bindings: Env; Variables: Variables };
export const rutasConector = new Hono<App>();

const ALCANCE = 'correo';
const VIDA_CODIGO = 60 * 10;
const VIDA_ACCESO = 60 * 60;
const VIDA_RENOVAR = 60 * 60 * 24 * 30;
const VERSIONES_MCP = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const origenDe = (c: Context) => new URL(c.req.url).origin;
const recursoDe = (c: Context) => `${origenDe(c)}/mcp`;

// ── CORS: los clientes web (p. ej. el inspector de MCP) hablan con estas rutas; no usan cookies, sólo Bearer. ──
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Accept',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};
const conCors = (r: Response) => { for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v); return r; };
for (const ruta of ['/mcp', '/oauth/token', '/oauth/registrar', '/oauth/revocar', '/.well-known/*']) {
  rutasConector.options(ruta, () => conCors(new Response(null, { status: 204 })));
}

// ── utilería ──
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function retoPkce(verificador: string) { return b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verificador))); }
const redirectValido = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)); } catch { return false; } };
const errorOAuth = (error: string, descripcion: string, estado: 400 | 401 = 400) =>
  conCors(new Response(JSON.stringify({ error, error_description: descripcion }), { status: estado, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
const json = (cuerpo: unknown, estado = 200, extra: Record<string, string> = {}) =>
  conCors(new Response(JSON.stringify(cuerpo), { status: estado, headers: { 'Content-Type': 'application/json', ...extra } }));

interface Cliente { id: string; nombre: string | null; redirect_uris: string; metodo_auth: string; secreto_hash: string | null; creado_at: string }
const clienteDe = (env: Env, cid: string) => env.DB.prepare(`SELECT * FROM oauth_clientes WHERE id = ?`).bind(cid).first<Cliente>();

// ── metadatos ──
const metadatosAS = (c: Context) => {
  const o = origenDe(c);
  return {
    issuer: o, authorization_endpoint: `${o}/oauth/autorizar`, token_endpoint: `${o}/oauth/token`, registration_endpoint: `${o}/oauth/registrar`, revocation_endpoint: `${o}/oauth/revocar`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [ALCANCE], service_documentation: o,
  };
};
rutasConector.get('/.well-known/oauth-authorization-server', (c) => json(metadatosAS(c), 200, { 'Cache-Control': 'public, max-age=3600' }));
rutasConector.get('/.well-known/oauth-authorization-server/*', (c) => json(metadatosAS(c), 200, { 'Cache-Control': 'public, max-age=3600' }));
rutasConector.get('/.well-known/openid-configuration', (c) => json(metadatosAS(c), 200, { 'Cache-Control': 'public, max-age=3600' }));
const metadatosRecurso = (c: Context) => ({ resource: recursoDe(c), authorization_servers: [origenDe(c)], scopes_supported: [ALCANCE], bearer_methods_supported: ['header'], resource_name: 'FSMAIL' });
rutasConector.get('/.well-known/oauth-protected-resource', (c) => json(metadatosRecurso(c), 200, { 'Cache-Control': 'public, max-age=3600' }));
rutasConector.get('/.well-known/oauth-protected-resource/*', (c) => json(metadatosRecurso(c), 200, { 'Cache-Control': 'public, max-age=3600' }));

// ── registro dinámico de clientes (RFC 7591) ──
rutasConector.post('/oauth/registrar', async (c) => {
  const b = await c.req.json<{ redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown; grant_types?: unknown; response_types?: unknown }>().catch(() => null);
  if (!b) return errorOAuth('invalid_client_metadata', 'JSON inválido');
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(redirectValido)) return errorOAuth('invalid_redirect_uri', 'redirect_uris: 1 a 10, https (o http a localhost)');
  const metodo = ['none', 'client_secret_post', 'client_secret_basic'].includes(String(b.token_endpoint_auth_method ?? 'none')) ? String(b.token_endpoint_auth_method ?? 'none') : 'none';
  const nombre = String(b.client_name ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, 80) || null;
  const cid = 'fsc_' + tokenAleatorio(16);
  const secreto = metodo === 'none' ? null : 'fss_' + tokenAleatorio(32);
  await c.env.DB.prepare(`INSERT INTO oauth_clientes (id, nombre, redirect_uris, metodo_auth, secreto_hash, creado_at) VALUES (?,?,?,?,?,?)`)
    .bind(cid, nombre, JSON.stringify(uris), metodo, secreto ? await sha256(secreto) : null, ahora()).run();
  return json({
    client_id: cid, client_id_issued_at: Math.floor(Date.now() / 1000), ...(secreto ? { client_secret: secreto, client_secret_expires_at: 0 } : {}),
    client_name: nombre, redirect_uris: uris, token_endpoint_auth_method: metodo, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: ALCANCE,
  }, 201, { 'Cache-Control': 'no-store' });
});

// ── autorización: pantalla de entrada/permiso y decisión ──
interface Pedido { client_id: string; redirect_uri: string; response_type: string; code_challenge: string; code_challenge_method: string; state: string; scope: string; resource: string }
const CAMPOS: (keyof Pedido)[] = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];
function volverCon(redirect: string, params: Record<string, string>) {
  const u = new URL(redirect); for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.toString(), 'Cache-Control': 'no-store' } });
}
/** Valida el pedido. Si el cliente o la redirección no sirven, nunca se redirige: se muestra el error aquí. */
async function validarPedido(c: Context<App>, p: Pedido): Promise<{ cliente: Cliente } | Response> {
  const cliente = p.client_id ? await clienteDe(c.env, p.client_id) : null;
  if (!cliente) return pagina(c, 'Cliente desconocido', '<p>La aplicación que pide acceso no está registrada en FSMAIL. Vuelve a agregar el conector desde Claude.</p>', 400);
  if (!(JSON.parse(cliente.redirect_uris) as string[]).includes(p.redirect_uri)) return pagina(c, 'Dirección de regreso inválida', '<p>La aplicación pidió volver a una dirección que no registró.</p>', 400);
  const fallo = (error: string, d: string) => volverCon(p.redirect_uri, { error, error_description: d, state: p.state, iss: origenDe(c) });
  if (p.response_type !== 'code') return fallo('unsupported_response_type', 'sólo code');
  if (!p.code_challenge || p.code_challenge_method !== 'S256') return fallo('invalid_request', 'PKCE S256 obligatorio');
  if (p.resource && p.resource.replace(/\/$/, '') !== recursoDe(c)) return fallo('invalid_target', 'recurso desconocido');
  return { cliente };
}
const pedidoDe = (src: Record<string, string | undefined>): Pedido => Object.fromEntries(CAMPOS.map((k) => [k, String(src[k] ?? '')])) as unknown as Pedido;

rutasConector.get('/oauth/autorizar', async (c) => {
  const p = pedidoDe(c.req.query());
  const v = await validarPedido(c, p); if (v instanceof Response) return v;
  const s = await cuentaDeSesion(c.env, c.req.header('Cookie'));
  const app = esc(v.cliente.nombre || 'Una aplicación');
  if (!s) return pagina(c, 'Entra a FSMAIL', `<p class="sub"><b>${app}</b> quiere conectarse a tu FSMAIL. Primero entra con tu cuenta.</p>
    <div id="paso1"><label>Usuario o correo</label><input id="u" autocomplete="username" autocapitalize="none"><button class="primario" id="b1">Mandarme un código</button></div>
    <div id="paso2" hidden><p class="sub" id="pista"></p><label>Código de 6 dígitos</label><input id="k" inputmode="numeric" maxlength="6" autocomplete="one-time-code"><button class="primario" id="b2">Entrar</button></div>
    <p class="error" id="e"></p>
    <script>
    const $=(s)=>document.querySelector(s);const post=async(r,b)=>{const x=await fetch('/api/auth/'+r,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b),credentials:'same-origin'});return x.json().catch(()=>({}))};
    $('#b1').onclick=async()=>{$('#e').textContent='';const j=await post('codigo',{usuario:$('#u').value.trim().toLowerCase()});if(j.ok===false&&j.error){$('#e').textContent='No se pudo: '+j.error;return}$('#pista').textContent=j.correo_pista?'Te mandamos un código a '+j.correo_pista+(j.codigo_prueba?' ('+j.codigo_prueba+')':''):'Si la cuenta existe, le llegó un código.';$('#paso1').hidden=true;$('#paso2').hidden=false;$('#k').focus()};
    $('#b2').onclick=async()=>{$('#e').textContent='';const j=await post('entrar',{usuario:$('#u').value.trim().toLowerCase(),codigo:$('#k').value});if(!j.ok){$('#e').textContent='Código incorrecto o vencido.';return}location.reload()};
    $('#u').onkeydown=(e)=>{if(e.key==='Enter')$('#b1').click()};$('#k').onkeydown=(e)=>{if(e.key==='Enter')$('#b2').click()};
    </script>`);
  const ocultos = CAMPOS.map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`).join('');
  return pagina(c, 'Conectar con FSMAIL', `<p class="sub"><b>${app}</b> quiere acceso a la cuenta <b>${esc(s.cuenta.username)}</b>.</p>
    <ul><li>Ver tus dominios, direcciones y bandejas.</li><li>Buscar y leer tus correos y conversaciones (abrirlos los marca leídos).</li><li>Enviar y responder desde tus direcciones, con su firma.</li><li>Archivar, borrar y marcar leído o no leído.</li></ul>
    <p class="sub">Puedes quitar el acceso cuando quieras desde FSMAIL (barra lateral → Conexiones) o desde el conector en Claude.</p>
    <form method="post" action="/oauth/autorizar">${ocultos}<div class="botones"><button name="decision" value="cancelar">Cancelar</button><button class="primario" name="decision" value="permitir" autofocus>Permitir</button></div></form>`);
});

rutasConector.post('/oauth/autorizar', async (c) => {
  // Mismo origen: la cookie de sesión es SameSite=Lax y además se revisa Origin.
  const origen = c.req.header('Origin');
  if (origen && origen !== origenDe(c)) return pagina(c, 'Pedido rechazado', '<p>El permiso tiene que darse desde FSMAIL.</p>', 403);
  const form = await c.req.parseBody();
  const p = pedidoDe(Object.fromEntries(Object.entries(form).map(([k, v]) => [k, typeof v === 'string' ? v : ''])));
  const v = await validarPedido(c, p); if (v instanceof Response) return v;
  const s = await cuentaDeSesion(c.env, c.req.header('Cookie'));
  if (!s) return pagina(c, 'Sesión vencida', '<p>Vuelve a intentarlo desde Claude.</p>', 401);
  if (form.decision !== 'permitir') return volverCon(p.redirect_uri, { error: 'access_denied', error_description: 'el usuario no dio permiso', state: p.state, iss: origenDe(c) });
  const codigo = 'fco_' + tokenAleatorio(32);
  await c.env.DB.prepare(`INSERT INTO oauth_codigos (hash, cliente_id, cuenta_id, redirect_uri, reto, alcance, recurso, expira_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(await sha256(codigo), v.cliente.id, s.cuenta.id, p.redirect_uri, p.code_challenge, ALCANCE, p.resource || null, enSegundos(VIDA_CODIGO)).run();
  return volverCon(p.redirect_uri, { code: codigo, state: p.state, iss: origenDe(c) });
});

// ── token ──
async function leerCuerpoOAuth(c: Context): Promise<Record<string, string>> {
  const tipo = c.req.header('Content-Type') ?? '';
  if (tipo.includes('application/json')) { const j = await c.req.json().catch(() => ({})); return Object.fromEntries(Object.entries(j as object).map(([k, v]) => [k, String(v)])); }
  const f = await c.req.parseBody().catch(() => ({})); return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
}
/** Autentica al cliente: público (sin secreto) o confidencial (secreto por cuerpo o Basic). */
async function autenticarCliente(c: Context<App>, b: Record<string, string>): Promise<Cliente | null> {
  let cid = b.client_id ?? '', secreto = b.client_secret ?? '';
  const basic = c.req.header('Authorization');
  if (basic?.startsWith('Basic ')) { try { const [u, s] = atob(basic.slice(6)).split(':'); cid = decodeURIComponent(u); secreto = decodeURIComponent(s ?? ''); } catch { return null; } }
  const cliente = cid ? await clienteDe(c.env, cid) : null;
  if (!cliente) return null;
  if (cliente.secreto_hash && !igualSeguro(await sha256(secreto), cliente.secreto_hash)) return null;
  return cliente;
}
async function emitirTokens(env: Env, cliente_id: string, cuenta_id: string, recurso: string | null) {
  const acceso = 'fat_' + tokenAleatorio(32), renovar = 'frt_' + tokenAleatorio(32), t = ahora();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO oauth_tokens (hash, tipo, cliente_id, cuenta_id, alcance, recurso, expira_at, creado_at) VALUES (?, 'acceso', ?,?,?,?,?,?)`).bind(await sha256(acceso), cliente_id, cuenta_id, ALCANCE, recurso, enSegundos(VIDA_ACCESO), t),
    env.DB.prepare(`INSERT INTO oauth_tokens (hash, tipo, cliente_id, cuenta_id, alcance, recurso, expira_at, creado_at) VALUES (?, 'renovar', ?,?,?,?,?,?)`).bind(await sha256(renovar), cliente_id, cuenta_id, ALCANCE, recurso, enSegundos(VIDA_RENOVAR), t),
    env.DB.prepare(`DELETE FROM oauth_tokens WHERE cuenta_id = ? AND expira_at < ?`).bind(cuenta_id, t),
  ]);
  return { access_token: acceso, token_type: 'Bearer', expires_in: VIDA_ACCESO, refresh_token: renovar, scope: ALCANCE };
}
rutasConector.post('/oauth/token', async (c) => {
  const b = await leerCuerpoOAuth(c);
  const cliente = await autenticarCliente(c, b);
  if (!cliente) return errorOAuth('invalid_client', 'cliente desconocido o secreto incorrecto', 401);
  if (b.grant_type === 'authorization_code') {
    const h = await sha256(b.code ?? '');
    const cod = await c.env.DB.prepare(`SELECT * FROM oauth_codigos WHERE hash = ?`).bind(h).first<{ cliente_id: string; cuenta_id: string; redirect_uri: string; reto: string; recurso: string | null; expira_at: string }>();
    if (cod) await c.env.DB.prepare(`DELETE FROM oauth_codigos WHERE hash = ?`).bind(h).run(); // un solo uso, salga bien o mal
    if (!cod || vencida(cod.expira_at) || cod.cliente_id !== cliente.id) return errorOAuth('invalid_grant', 'código inválido, usado o vencido');
    if (b.redirect_uri && b.redirect_uri !== cod.redirect_uri) return errorOAuth('invalid_grant', 'redirect_uri distinta');
    if (!b.code_verifier || !igualSeguro(await retoPkce(b.code_verifier), cod.reto)) return errorOAuth('invalid_grant', 'PKCE no coincide');
    return json(await emitirTokens(c.env, cliente.id, cod.cuenta_id, cod.recurso), 200, { 'Cache-Control': 'no-store' });
  }
  if (b.grant_type === 'refresh_token') {
    const h = await sha256(b.refresh_token ?? '');
    const t = await c.env.DB.prepare(`SELECT * FROM oauth_tokens WHERE hash = ? AND tipo = 'renovar'`).bind(h).first<{ cliente_id: string; cuenta_id: string; recurso: string | null; expira_at: string }>();
    if (!t || vencida(t.expira_at) || t.cliente_id !== cliente.id) return errorOAuth('invalid_grant', 'token de renovación inválido');
    await c.env.DB.prepare(`DELETE FROM oauth_tokens WHERE hash = ?`).bind(h).run(); // rotación: el viejo deja de servir
    return json(await emitirTokens(c.env, cliente.id, t.cuenta_id, t.recurso), 200, { 'Cache-Control': 'no-store' });
  }
  return errorOAuth('unsupported_grant_type', 'sólo authorization_code y refresh_token');
});

// ── revocación (RFC 7009): siempre 200 ──
rutasConector.post('/oauth/revocar', async (c) => {
  const b = await leerCuerpoOAuth(c);
  const cliente = await autenticarCliente(c, b);
  if (cliente && b.token) await c.env.DB.prepare(`DELETE FROM oauth_tokens WHERE hash = ? AND cliente_id = ?`).bind(await sha256(b.token), cliente.id).run();
  return conCors(new Response(null, { status: 200 }));
});

// ── el servidor MCP ──
async function cuentaDeToken(c: Context<App>): Promise<Cuenta | null> {
  const a = c.req.header('Authorization') ?? '';
  if (!a.startsWith('Bearer ')) return null;
  const h = await sha256(a.slice(7).trim());
  const fila = await c.env.DB.prepare(`SELECT c.*, t.expira_at AS t_expira, t.usado_at AS t_usado FROM oauth_tokens t JOIN cuentas c ON c.id = t.cuenta_id WHERE t.hash = ? AND t.tipo = 'acceso'`).bind(h).first<Cuenta & { t_expira: string; t_usado: string | null }>();
  if (!fila || vencida(fila.t_expira)) return null;
  // Último uso, a lo más una escritura por minuto.
  if (!fila.t_usado || Date.now() - Date.parse(fila.t_usado) > 60_000) await c.env.DB.prepare(`UPDATE oauth_tokens SET usado_at = ? WHERE hash = ?`).bind(ahora(), h).run();
  const { t_expira: _a, t_usado: _b, ...cuenta } = fila;
  return cuenta;
}
const sinToken = (c: Context, conToken: boolean) => conCors(new Response(JSON.stringify({ error: 'invalid_token', error_description: 'Falta o venció el token: conecta FSMAIL de nuevo.' }), {
  status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer resource_metadata="${origenDe(c)}/.well-known/oauth-protected-resource"${conToken ? ', error="invalid_token"' : ''}, scope="${ALCANCE}"` },
}));

rutasConector.get('/mcp', (c) => conCors(new Response('FSMAIL MCP: usa POST', { status: 405, headers: { Allow: 'POST, OPTIONS' } })));
rutasConector.delete('/mcp', (c) => conCors(new Response(null, { status: 405, headers: { Allow: 'POST, OPTIONS' } })));
rutasConector.post('/mcp', async (c) => {
  const cuenta = await cuentaDeToken(c);
  if (!cuenta) return sinToken(c, !!c.req.header('Authorization'));
  let cuerpo: unknown;
  try { cuerpo = await c.req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }, 400); }
  const lote = Array.isArray(cuerpo) ? cuerpo : [cuerpo];
  const api = interno(c.env, cuenta);
  const respuestas = (await Promise.all(lote.map((m) => atender(api, m as Rpc, cuenta)))).filter((r): r is object => r !== null);
  if (!respuestas.length) return conCors(new Response(null, { status: 202 }));
  return json(Array.isArray(cuerpo) ? respuestas : respuestas[0]);
});

interface Rpc { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
type Api = (ruta: string, metodo?: string, cuerpo?: unknown) => Promise<Record<string, any>>;

/** La API de FSMAIL, llamada por dentro con la cuenta del token: mismas rutas y reglas que la interfaz. */
function interno(env: Env, cuenta: Cuenta): Api {
  const a = new Hono<App>();
  a.use('*', async (c, next) => { c.set('cuenta', cuenta); await next(); });
  a.route('/dominios', rutasDominios);
  a.route('/mensajes', rutasMensajes);
  return async (ruta, metodo = 'GET', cuerpo) => {
    const r = await a.request(ruta, { method: metodo, headers: cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}, body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined }, env);
    const j = await r.json().catch(() => ({ ok: false, error: `respuesta ${r.status}` })) as Record<string, any>;
    return { estado: r.status, ...j };
  };
}

async function atender(api: Api, m: Rpc, cuenta: Cuenta): Promise<object | null> {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Petición JSON-RPC inválida' } };
  const esNotificacion = m.id === undefined;
  const ok = (result: unknown) => (esNotificacion ? null : { jsonrpc: '2.0', id: m.id, result });
  const mal = (code: number, message: string) => (esNotificacion ? null : { jsonrpc: '2.0', id: m.id, error: { code, message } });
  switch (m.method) {
    case 'initialize': {
      const pedida = String(m.params?.protocolVersion ?? '');
      return ok({
        protocolVersion: VERSIONES_MCP.includes(pedida) ? pedida : VERSIONES_MCP[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fsmail', title: 'FSMAIL', version: '1.0.0' },
        instructions: `FSMAIL es el correo de los dominios de ${cuenta.nombre || cuenta.username}. Usa listar_dominios para saber qué direcciones hay; listar_correos para buscar; leer_conversacion para leer un hilo completo; enviar_correo para escribir o responder (siempre desde una dirección de la cuenta, con su firma); mover_correos para archivar, borrar o marcar. Antes de enviar, muestra al usuario el texto y los destinatarios.`,
      });
    }
    case 'notifications/initialized': case 'notifications/cancelled': return null;
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: HERRAMIENTAS.map(({ correr: _c, ...t }) => t) });
    case 'tools/call': {
      const nombre = String(m.params?.name ?? ''); const h = HERRAMIENTAS.find((x) => x.name === nombre);
      if (!h) return mal(-32602, `Herramienta desconocida: ${nombre}`);
      try {
        const r = await h.correr(api, (m.params?.arguments ?? {}) as Record<string, any>);
        return ok({ content: [{ type: 'text', text: r.texto }], ...(r.datos ? { structuredContent: r.datos } : {}), isError: !!r.error });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `No se pudo: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
      }
    }
    case 'resources/list': return ok({ resources: [] });
    case 'prompts/list': return ok({ prompts: [] });
    default: return mal(-32601, `Método no soportado: ${m.method}`);
  }
}

// ── herramientas ──
interface Resultado { texto: string; datos?: Record<string, unknown>; error?: boolean }
interface Herramienta { name: string; title: string; description: string; inputSchema: object; annotations: object; correr: (api: Api, a: Record<string, any>) => Promise<Resultado> }
const CARPETAS = ['entrada', 'enviados', 'archivo', 'basura'];
const fallo = (j: Record<string, any>): Resultado => ({ texto: `FSMAIL contestó: ${j.error ?? 'error'}${j.detalle ? ` (${j.detalle})` : ''}`, error: true });
const fechaCorta = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const deHtml = (html: string) => html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();

async function mapaDirecciones(api: Api) {
  const d = await api('/dominios'); if (!d.ok) throw new Error(d.error);
  const dominios = d.dominios as Array<{ id: string; dominio: string; estado: string; direcciones: Array<{ id: string; local: string; activa: boolean }> }>;
  const porCorreo = new Map<string, { id: string; dominio_id: string; activa: boolean }>();
  for (const x of dominios) for (const y of x.direcciones) porCorreo.set(`${y.local}@${x.dominio}`.toLowerCase(), { id: y.id, dominio_id: x.id, activa: y.activa });
  return { dominios, porCorreo, porNombre: new Map(dominios.map((x) => [x.dominio.toLowerCase(), x])) };
}

const HERRAMIENTAS: Herramienta[] = [
  {
    name: 'listar_dominios', title: 'Dominios y direcciones',
    description: 'Lista los dominios de la cuenta FSMAIL, su estado y sus direcciones de correo, con cuántos correos sin leer tiene cada una en la entrada.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Dominios y direcciones', readOnlyHint: true, openWorldHint: false },
    async correr(api) {
      const [d, c] = await Promise.all([api('/dominios'), api('/mensajes/conteos')]);
      if (!d.ok) return fallo(d);
      const conteos = (c.conteos ?? []) as Array<{ dominio_id: string; direccion_id: string | null; total: number; sin_leer: number }>;
      const sin = (dom: string, dir?: string | null) => conteos.filter((x) => x.dominio_id === dom && (dir === undefined || x.direccion_id === dir)).reduce((n, x) => n + x.sin_leer, 0);
      const dominios = (d.dominios as any[]).map((x) => ({ dominio: x.dominio, estado: x.estado, sin_leer: sin(x.id), sin_leer_sin_direccion: sin(x.id, null), direcciones: x.direcciones.map((y: any) => ({ correo: `${y.local}@${x.dominio}`, nombre: y.nombre, activa: y.activa, sin_leer: sin(x.id, y.id) })) }));
      const texto = dominios.map((x) => `${x.dominio} (${x.estado}) · ${x.sin_leer} sin leer\n` + (x.direcciones.map((y: any) => `  - ${y.correo}${y.activa ? '' : ' (inactiva)'} · ${y.sin_leer} sin leer`).join('\n') || '  (sin direcciones)') + (x.sin_leer_sin_direccion ? `\n  - sin dirección · ${x.sin_leer_sin_direccion} sin leer` : '')).join('\n') || 'La cuenta no tiene dominios.';
      return { texto, datos: { dominios } };
    },
  },
  {
    name: 'listar_correos', title: 'Buscar correos',
    description: 'Lista correos de una carpeta, del más nuevo al más viejo. Filtra por dominio, por dirección, por sin leer o por texto (asunto, remitente o resumen). Devuelve el id de cada correo para leerlo con leer_conversacion.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      carpeta: { type: 'string', enum: CARPETAS, description: 'Por omisión, entrada.' },
      dominio: { type: 'string', description: 'p. ej. kranko.app' },
      direccion: { type: 'string', description: 'p. ej. ventas@kranko.app' },
      sin_leer: { type: 'boolean' },
      buscar: { type: 'string' },
      limite: { type: 'integer', minimum: 1, maximum: 50, description: 'Por omisión, 20.' },
    } },
    annotations: { title: 'Buscar correos', readOnlyHint: true, openWorldHint: false },
    async correr(api, a) {
      const p = new URLSearchParams({ carpeta: CARPETAS.includes(a.carpeta) ? a.carpeta : 'entrada', limite: String(Math.min(Math.max(Number(a.limite) || 20, 1), 50)) });
      if (a.dominio || a.direccion) {
        const m = await mapaDirecciones(api);
        if (a.direccion) { const x = m.porCorreo.get(String(a.direccion).toLowerCase()); if (!x) return { texto: `No existe la dirección ${a.direccion} en esta cuenta.`, error: true }; p.set('dominio', x.dominio_id); p.set('direccion', x.id); }
        else { const x = m.porNombre.get(String(a.dominio).toLowerCase()); if (!x) return { texto: `No existe el dominio ${a.dominio} en esta cuenta.`, error: true }; p.set('dominio', x.id); }
      }
      if (a.sin_leer) p.set('sin_leer', '1');
      if (a.buscar) p.set('q', String(a.buscar).slice(0, 200));
      const j = await api('/mensajes?' + p); if (!j.ok) return fallo(j);
      const correos = (j.mensajes as any[]).map((m) => ({ id: m.id, fecha: m.fecha, de: m.de_nombre ? `${m.de_nombre} <${m.de}>` : m.de, para: m.para, asunto: m.asunto, resumen: m.resumen, leido: m.leido, adjuntos: m.adjuntos, mensajes_en_conversacion: m.hilo_n ?? 1 }));
      const texto = correos.map((m) => `[${m.id}] ${fechaCorta(m.fecha)} · ${m.leido ? '' : '● '}${m.de} → ${m.para.join(', ')}\n    ${m.asunto || '(sin asunto)'}${m.adjuntos ? ` · 📎${m.adjuntos}` : ''}${m.mensajes_en_conversacion > 1 ? ` · ${m.mensajes_en_conversacion} en la conversación` : ''}\n    ${m.resumen || ''}`).join('\n') || 'No hay correos con ese filtro.';
      return { texto: texto + (j.hay_mas ? '\n(hay más; sube el límite o afina el filtro)' : ''), datos: { correos, hay_mas: !!j.hay_mas } };
    },
  },
  {
    name: 'leer_conversacion', title: 'Leer conversación',
    description: 'Lee la conversación completa de un correo (todos los mensajes del hilo, del más viejo al más nuevo) con el texto de cada uno y sus adjuntos. Abrirla la marca como leída.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', description: 'El id de un correo, de listar_correos.' } } },
    annotations: { title: 'Leer conversación', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async correr(api, a) {
      const j = await api(`/mensajes/${encodeURIComponent(String(a.id ?? ''))}/hilo`); if (!j.ok) return fallo(j);
      let total = 0;
      const mensajes = (j.mensajes as any[]).map((x) => {
        const m = x.mensaje, c = x.contenido ?? {};
        let cuerpo = c.text ? String(c.text) : c.html ? deHtml(String(c.html)) : '';
        if (cuerpo.length > 12000) cuerpo = cuerpo.slice(0, 12000) + '\n[… recortado]';
        if (total > 60000) cuerpo = '[… omitido: la conversación es muy larga]'; total += cuerpo.length;
        return { id: m.id, fecha: m.fecha, carpeta: m.carpeta, de: m.de_nombre ? `${m.de_nombre} <${m.de}>` : m.de, para: m.para, asunto: m.asunto, cuerpo, adjuntos: (x.adjuntos as any[]).map((y) => ({ nombre: y.nombre, tipo: y.tipo, tamano: y.tamano })) };
      });
      const texto = `Conversación: ${j.hilo.asunto || '(sin asunto)'} · ${mensajes.length} mensaje(s)\n\n` + mensajes.map((m, i) => `── ${i + 1}. [${m.id}] ${fechaCorta(m.fecha)} · ${m.carpeta === 'enviados' ? 'ENVIADO' : 'RECIBIDO'}\nDe: ${m.de}\nPara: ${m.para.join(', ')}\nAsunto: ${m.asunto || '(sin asunto)'}${m.adjuntos.length ? `\nAdjuntos: ${m.adjuntos.map((y) => y.nombre).join(', ')}` : ''}\n\n${m.cuerpo}`).join('\n\n');
      return { texto, datos: { hilo: j.hilo, mensajes } };
    },
  },
  {
    name: 'enviar_correo', title: 'Enviar o responder',
    description: 'Envía un correo desde una dirección de la cuenta (sale con su firma). Para responder, pasa responder_a con el id del correo: si no das «para» ni «asunto», se responden al remitente con «Re: …» y queda en la misma conversación. Muestra el texto al usuario y pide su visto bueno antes de llamar esta herramienta.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['texto'], properties: {
      desde: { type: 'string', description: 'Dirección que envía, p. ej. mike@kranko.app. Si respondes y la omites, se usa la dirección que recibió el correo.' },
      para: { type: 'array', items: { type: 'string' }, description: 'Destinatarios.' },
      cc: { type: 'array', items: { type: 'string' } },
      asunto: { type: 'string' },
      texto: { type: 'string', description: 'Cuerpo en texto plano.' },
      responder_a: { type: 'string', description: 'id del correo al que se responde.' },
    } },
    annotations: { title: 'Enviar o responder', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async correr(api, a) {
      const m = await mapaDirecciones(api);
      let para: string[] = Array.isArray(a.para) ? a.para.map(String) : a.para ? [String(a.para)] : [];
      let asunto = a.asunto !== undefined ? String(a.asunto) : undefined;
      let direccion = a.desde ? m.porCorreo.get(String(a.desde).toLowerCase()) : undefined;
      if (a.desde && !direccion) return { texto: `No existe la dirección ${a.desde} en esta cuenta. Usa listar_dominios.`, error: true };
      if (a.responder_a) {
        const o = await api(`/mensajes/${encodeURIComponent(String(a.responder_a))}`); if (!o.ok) return fallo(o);
        const om = o.mensaje;
        if (!para.length) para = om.carpeta === 'enviados' ? om.para : [om.de];
        if (asunto === undefined) asunto = /^re:/i.test(om.asunto || '') ? om.asunto : `Re: ${om.asunto || ''}`;
        if (!direccion) {
          const dom = m.dominios.find((x) => x.id === om.dominio_id);
          const y = dom?.direcciones.find((z) => z.id === om.direccion_id && z.activa) ?? dom?.direcciones.find((z) => z.activa);
          if (y) direccion = { id: y.id, dominio_id: dom!.id, activa: y.activa };
        }
      }
      if (!direccion) return { texto: 'Falta «desde»: la dirección de la cuenta que envía.', error: true };
      if (!para.length) return { texto: 'Falta «para».', error: true };
      const j = await api('/mensajes/enviar', 'POST', { direccion_id: direccion.id, para, cc: Array.isArray(a.cc) ? a.cc.map(String) : [], asunto: asunto ?? '', texto: String(a.texto ?? ''), ...(a.responder_a ? { en_respuesta_a: String(a.responder_a) } : {}) });
      if (!j.ok) return fallo(j);
      const desde = [...m.porCorreo.entries()].find(([, v]) => v.id === direccion!.id)?.[0];
      return { texto: `Enviado desde ${desde} a ${para.join(', ')} · «${asunto ?? ''}» · id ${j.mensaje.id}`, datos: { id: j.mensaje.id, conversacion: j.mensaje.hilo_id, desde, para, asunto } };
    },
  },
  {
    name: 'mover_correos', title: 'Archivar, borrar o marcar',
    description: 'Aplica una acción a uno o varios correos (hasta 200): archivar, borrar (va a la basura, se puede regresar), regresar a la entrada, marcar leído o marcar no leído.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['ids', 'accion'], properties: {
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200 },
      accion: { type: 'string', enum: ['archivar', 'borrar', 'entrada', 'leido', 'no_leido'] },
    } },
    annotations: { title: 'Archivar, borrar o marcar', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async correr(api, a) {
      const cuerpo = ({ archivar: { carpeta: 'archivo' }, borrar: { carpeta: 'basura' }, entrada: { carpeta: 'entrada' }, leido: { leido: true }, no_leido: { leido: false } } as Record<string, object>)[String(a.accion)];
      if (!cuerpo) return { texto: 'Acción desconocida.', error: true };
      const ids = Array.isArray(a.ids) ? a.ids.map(String) : [];
      const j = await api('/mensajes/lote', 'PATCH', { ids, ...cuerpo }); if (!j.ok) return fallo(j);
      return { texto: `${j.cambiados} de ${ids.length} correo(s): ${a.accion}.`, datos: { cambiados: j.cambiados } };
    },
  },
];

// ── conexiones de la cuenta (para la interfaz) ──
export const rutasConexiones = new Hono<App>();
rutasConexiones.get('/', async (c) => {
  const cu = c.get('cuenta');
  const filas = (await c.env.DB.prepare(
    `SELECT t.cliente_id, k.nombre, MIN(t.creado_at) AS desde, MAX(t.usado_at) AS usado FROM oauth_tokens t LEFT JOIN oauth_clientes k ON k.id = t.cliente_id
      WHERE t.cuenta_id = ? AND t.expira_at > ? GROUP BY t.cliente_id, k.nombre ORDER BY desde`,
  ).bind(cu.id, ahora()).all<{ cliente_id: string; nombre: string | null; desde: string; usado: string | null }>()).results;
  return c.json({ ok: true, url: `${origenDe(c)}/mcp`, conexiones: filas });
});
rutasConexiones.delete('/:cliente', async (c) => {
  const cu = c.get('cuenta');
  const r = await c.env.DB.prepare(`DELETE FROM oauth_tokens WHERE cuenta_id = ? AND cliente_id = ?`).bind(cu.id, c.req.param('cliente')).run();
  return c.json({ ok: true, borrados: r.meta.changes ?? 0 });
});
void err;

// ── página mínima con la marca, para entrar y dar permiso ──
function pagina(c: Context, titulo: string, cuerpo: string, estado: 200 | 400 | 401 | 403 = 200) {
  return c.html(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(titulo)} · FSMAIL</title><link rel="icon" href="/logo.svg" type="image/svg+xml">
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#f4f3fb;font:15px/1.5 Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:#15171c}
.t{background:#fff;border-radius:22px;padding:28px;max-width:440px;width:100%;box-shadow:0 30px 70px rgba(30,32,56,.16)}.m{display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:3px;margin-bottom:14px}.m img{width:40px;height:40px;border-radius:11px}
h1{font-size:20px;margin:0 0 8px}.sub{color:#555b66}ul{padding-left:20px;color:#3b3f48}li{margin:4px 0}label{display:block;font-size:12px;font-weight:600;color:#6b7280;margin:12px 0 5px}
input{font:inherit;width:100%;padding:10px 12px;border:1px solid #e8eaef;border-radius:12px;background:#f6f7f9}button{font:inherit;padding:10px 16px;border-radius:12px;border:1px solid #e8eaef;background:#f6f7f9;cursor:pointer;margin-top:12px}
button.primario{background:#6c5ce7;border-color:#6c5ce7;color:#fff;font-weight:600}.botones{display:flex;gap:8px;justify-content:flex-end}.error{color:#ef5350;min-height:20px}</style></head>
<body><main class="t"><div class="m"><img src="/logo.svg" alt="">FSMAIL</div><h1>${esc(titulo)}</h1>${cuerpo}</main></body></html>`, estado);
}
