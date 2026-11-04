import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { BASE, cuentaNueva, direccion, dominioVerificado, json, recibido, webhook, fetchDeMentira, sinPendientes, esperaResend } from './ayuda';
import { retoPkce } from '../src/conector';

beforeAll(fetchDeMentira);
afterEach(sinPendientes);

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const sinRedirigir = (ruta: string, init: RequestInit = {}) => SELF.fetch(BASE + ruta, { ...init, redirect: 'manual' });

async function registrarCliente(extra: Record<string, unknown> = {}) {
  const r = await json('/oauth/registrar', { redirect_uris: [CALLBACK], client_name: 'Claude', ...extra });
  expect(r.estado).toBe(201);
  return r as { client_id: string; client_secret?: string };
}
/** Pide permiso con la sesión y devuelve el código que llega al callback. */
async function codigoPara(cookie: string, client_id: string, verificador: string, extra: Record<string, string> = {}) {
  const r = await sinRedirigir('/oauth/autorizar', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE },
    body: form({ client_id, redirect_uri: CALLBACK, response_type: 'code', code_challenge: await retoPkce(verificador), code_challenge_method: 'S256', state: 'st-1', scope: 'correo', resource: `${BASE}/mcp`, decision: 'permitir', ...extra }),
  });
  expect(r.status).toBe(302);
  const u = new URL(r.headers.get('Location')!);
  expect(u.origin + u.pathname).toBe(CALLBACK); expect(u.searchParams.get('state')).toBe('st-1'); expect(u.searchParams.get('iss')).toBe(BASE);
  return u.searchParams.get('code')!;
}
const token = (cuerpo: Record<string, string>) => SELF.fetch(BASE + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(cuerpo) }).then(async (r) => ({ estado: r.status, ...(await r.json() as any) }));
let n = 0;
const mcp = (acceso: string, method: string, params?: unknown) => json('/mcp', { jsonrpc: '2.0', id: ++n, method, ...(params ? { params } : {}) }, { headers: { Authorization: `Bearer ${acceso}`, Accept: 'application/json, text/event-stream' } });
const herramienta = async (acceso: string, name: string, args: Record<string, unknown> = {}) => (await mcp(acceso, 'tools/call', { name, arguments: args })).result;

describe('conector: metadatos y registro', () => {
  it('anuncia el recurso y el servidor de autorización; sin token, 401 con la pista para descubrirlos', async () => {
    const pr = await json('/.well-known/oauth-protected-resource');
    expect(pr).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    expect((await json('/.well-known/oauth-protected-resource/mcp')).resource).toBe(`${BASE}/mcp`);
    const as = await json('/.well-known/oauth-authorization-server');
    expect(as).toMatchObject({ issuer: BASE, authorization_endpoint: `${BASE}/oauth/autorizar`, token_endpoint: `${BASE}/oauth/token`, registration_endpoint: `${BASE}/oauth/registrar`, code_challenge_methods_supported: ['S256'] });
    const r = await SELF.fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('WWW-Authenticate')).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const malo = await SELF.fetch(BASE + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer fat_inventado' }, body: '{}' });
    expect(malo.status).toBe(401); expect(malo.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
    expect((await SELF.fetch(BASE + '/mcp')).status).toBe(405);
  });
  it('registro dinámico: acepta https y localhost, rechaza lo demás; los confidenciales reciben secreto', async () => {
    expect((await json('/oauth/registrar', { redirect_uris: ['http://malo.com/cb'] })).error).toBe('invalid_redirect_uri');
    expect((await json('/oauth/registrar', { redirect_uris: [] })).error).toBe('invalid_redirect_uri');
    const pub = await registrarCliente(); expect(pub.client_id).toMatch(/^fsc_/); expect(pub.client_secret).toBeUndefined();
    const loc = await json('/oauth/registrar', { redirect_uris: ['http://localhost:6274/oauth/callback'] }); expect(loc.estado).toBe(201);
    const conf = await registrarCliente({ token_endpoint_auth_method: 'client_secret_post' }); expect(conf.client_secret).toMatch(/^fss_/);
  });
});

describe('conector: autorización', () => {
  it('sin sesión pide entrar; con sesión pide permiso; errores de cliente o redirección no redirigen', async () => {
    const { cookie } = await cuentaNueva('u-c1');
    const { client_id } = await registrarCliente();
    const q = (o: Record<string, string>) => '/oauth/autorizar?' + form({ client_id, redirect_uri: CALLBACK, response_type: 'code', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's', ...o });
    const sin = await SELF.fetch(BASE + q({})); expect(sin.status).toBe(200); expect(await sin.text()).toContain('Entra a FSMAIL');
    const con = await SELF.fetch(BASE + q({}), { headers: { Cookie: cookie } }); const html = await con.text();
    expect(html).toContain('Permitir'); expect(html).toContain('u-c1'); expect(html).toContain('Claude');
    expect((await SELF.fetch(BASE + q({ client_id: 'fsc_nadie' }))).status).toBe(400);
    expect((await SELF.fetch(BASE + q({ redirect_uri: 'https://otro.com/cb' }))).status).toBe(400);
    const sinPkce = await sinRedirigir(q({ code_challenge: '' }), { headers: { Cookie: cookie } });
    expect(sinPkce.status).toBe(302); expect(sinPkce.headers.get('Location')).toContain('error=invalid_request');
    const recurso = await sinRedirigir(q({ resource: 'https://otro.com/mcp' }), { headers: { Cookie: cookie } });
    expect(recurso.headers.get('Location')).toContain('error=invalid_target');
    // Cancelar, origen ajeno y sin sesión.
    const cuerpo = form({ client_id, redirect_uri: CALLBACK, response_type: 'code', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's', decision: 'cancelar' });
    const cancel = await sinRedirigir('/oauth/autorizar', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: cuerpo });
    expect(cancel.headers.get('Location')).toContain('error=access_denied');
    expect((await sinRedirigir('/oauth/autorizar', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://malo.com', 'Content-Type': 'application/x-www-form-urlencoded' }, body: cuerpo.replace('cancelar', 'permitir') })).status).toBe(403);
    expect((await sinRedirigir('/oauth/autorizar', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: cuerpo.replace('cancelar', 'permitir') })).status).toBe(401);
  });
  it('el código sirve una vez, con el mismo cliente y el verificador PKCE correcto; el refresco rota', async () => {
    const { cookie } = await cuentaNueva('u-c2');
    const { client_id } = await registrarCliente();
    const otro = await registrarCliente();
    const a = await codigoPara(cookie, client_id, 'verificador-uno-'.repeat(4));
    expect((await token({ grant_type: 'authorization_code', code: a, client_id, redirect_uri: CALLBACK, code_verifier: 'equivocado'.repeat(5) })).error).toBe('invalid_grant');
    expect((await token({ grant_type: 'authorization_code', code: a, client_id, redirect_uri: CALLBACK, code_verifier: 'verificador-uno-'.repeat(4) })).error).toBe('invalid_grant'); // ya se usó
    const b = await codigoPara(cookie, client_id, 'verificador-dos-'.repeat(4));
    expect((await token({ grant_type: 'authorization_code', code: b, client_id: otro.client_id, redirect_uri: CALLBACK, code_verifier: 'verificador-dos-'.repeat(4) })).error).toBe('invalid_grant');
    const c = await codigoPara(cookie, client_id, 'verificador-tres'.repeat(4));
    const t = await token({ grant_type: 'authorization_code', code: c, client_id, redirect_uri: CALLBACK, code_verifier: 'verificador-tres'.repeat(4) });
    expect(t).toMatchObject({ estado: 200, token_type: 'Bearer', expires_in: 3600, scope: 'correo' });
    expect(t.access_token).toMatch(/^fat_/); expect(t.refresh_token).toMatch(/^frt_/);
    expect((await mcp(t.access_token, 'ping')).result).toEqual({});
    const t2 = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id });
    expect(t2.estado).toBe(200); expect(t2.access_token).not.toBe(t.access_token);
    expect((await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id })).error).toBe('invalid_grant'); // rotado
    expect((await token({ grant_type: 'password', client_id })).error).toBe('unsupported_grant_type');
    expect((await token({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: 'fsc_nadie' })).estado).toBe(401);
  });
  it('un cliente confidencial necesita su secreto', async () => {
    const { cookie } = await cuentaNueva('u-c3');
    const conf = await registrarCliente({ token_endpoint_auth_method: 'client_secret_post' });
    const code = await codigoPara(cookie, conf.client_id, 'v'.repeat(50));
    expect((await token({ grant_type: 'authorization_code', code, client_id: conf.client_id, code_verifier: 'v'.repeat(50) })).error).toBe('invalid_client');
    const code2 = await codigoPara(cookie, conf.client_id, 'w'.repeat(50));
    const ok = await token({ grant_type: 'authorization_code', code: code2, client_id: conf.client_id, client_secret: conf.client_secret!, code_verifier: 'w'.repeat(50) });
    expect(ok.estado).toBe(200);
  });
});

describe('conector: las herramientas por MCP', () => {
  it('initialize, tools/list y las cinco herramientas sobre correo real de la cuenta; desconectar corta el acceso', async () => {
    const { cookie } = await cuentaNueva('u-c4');
    const d = await dominioVerificado(cookie, 'mcp.mx');
    const hola = await direccion(cookie, d.id, 'hola', 'Hola MCP');
    await direccion(cookie, d.id, 'ventas');
    esperaResend('GET', '/emails/receiving/em_mcp', recibido({ id: 'em_mcp', de: 'Cliente <c@gmail.com>', para: ['hola@mcp.mx'], asunto: 'Precio del plan', texto: '¿Cuánto cuesta el plan anual?', message_id: '<mcp1@gmail.com>' }));
    await webhook({ type: 'email.received', data: { email_id: 'em_mcp' } });
    const { client_id } = await registrarCliente();
    const code = await codigoPara(cookie, client_id, 'z'.repeat(60));
    const { access_token: at } = await token({ grant_type: 'authorization_code', code, client_id, redirect_uri: CALLBACK, code_verifier: 'z'.repeat(60) });

    const ini = await mcp(at, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'prueba', version: '1' } });
    expect(ini.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fsmail' } });
    expect((await mcp(at, 'initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe('2025-11-25');
    const notif = await SELF.fetch(BASE + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
    expect(notif.status).toBe(202);
    const lista = (await mcp(at, 'tools/list')).result.tools;
    expect(lista.map((t: any) => t.name)).toEqual(['listar_dominios', 'listar_correos', 'leer_conversacion', 'enviar_correo', 'mover_correos']);
    expect(lista.every((t: any) => t.inputSchema.type === 'object' && t.annotations)).toBe(true);
    expect((await mcp(at, 'no/existe')).error.code).toBe(-32601);
    expect((await mcp(at, 'tools/call', { name: 'nada' })).error.code).toBe(-32602);

    const dom = await herramienta(at, 'listar_dominios');
    expect(dom.isError).toBe(false); expect(dom.content[0].text).toContain('hola@mcp.mx');
    expect(dom.structuredContent.dominios[0]).toMatchObject({ dominio: 'mcp.mx', sin_leer: 1 });

    const lis = await herramienta(at, 'listar_correos', { direccion: 'hola@mcp.mx', sin_leer: true });
    expect(lis.structuredContent.correos).toHaveLength(1);
    const mid = lis.structuredContent.correos[0].id;
    expect(lis.content[0].text).toContain('Precio del plan');
    expect((await herramienta(at, 'listar_correos', { direccion: 'nadie@mcp.mx' })).isError).toBe(true);

    const leer = await herramienta(at, 'leer_conversacion', { id: mid });
    expect(leer.content[0].text).toContain('¿Cuánto cuesta el plan anual?'); expect(leer.structuredContent.mensajes).toHaveLength(1);

    let pedido: any;
    esperaResend('POST', '/emails', { id: 'env_mcp' }, { estado: 200, capturar: (b) => { pedido = b; } });
    const env = await herramienta(at, 'enviar_correo', { responder_a: mid, texto: 'El plan anual cuesta 1,200.' });
    expect(env.isError).toBe(false);
    expect(pedido.from).toBe('Hola MCP <hola@mcp.mx>'); expect(pedido.to).toEqual(['c@gmail.com']); expect(pedido.subject).toBe('Re: Precio del plan');
    expect(pedido.headers['In-Reply-To']).toBe('<mcp1@gmail.com>');
    const hilo = await herramienta(at, 'leer_conversacion', { id: mid });
    expect(hilo.structuredContent.mensajes.map((m: any) => m.carpeta)).toEqual(['entrada', 'enviados']);
    // Desde otra dirección de la cuenta, y desde una que no existe.
    esperaResend('POST', '/emails', { id: 'env_mcp2' }, { estado: 200, capturar: (b) => { pedido = b; } });
    expect((await herramienta(at, 'enviar_correo', { desde: 'ventas@mcp.mx', para: ['x@y.mx'], asunto: 'Hola', texto: 'Prueba' })).isError).toBe(false);
    expect(pedido.from).toContain('<ventas@mcp.mx>');
    expect((await herramienta(at, 'enviar_correo', { desde: 'ajena@otro.mx', para: ['x@y.mx'], texto: 'x' })).isError).toBe(true);

    const mov = await herramienta(at, 'mover_correos', { ids: [mid], accion: 'borrar' });
    expect(mov.structuredContent.cambiados).toBe(1);
    expect((await json('/api/mensajes', undefined, { cookie })).mensajes).toHaveLength(0);

    // Conexiones en la interfaz y desconectar.
    const cx = await json('/api/conexiones', undefined, { cookie });
    expect(cx.url).toBe(`${BASE}/mcp`); expect(cx.conexiones).toHaveLength(1); expect(cx.conexiones[0]).toMatchObject({ cliente_id: client_id, nombre: 'Claude' });
    expect(cx.conexiones[0].usado).toBeTruthy();
    await json(`/api/conexiones/${client_id}`, undefined, { cookie, metodo: 'DELETE' });
    expect((await mcp(at, 'ping')).estado).toBe(401);
    void hola;
  });
  it('el token de una cuenta no ve el correo de otra', async () => {
    const a = await cuentaNueva('u-c5'); const b = await cuentaNueva('u-c6');
    const d = await dominioVerificado(a.cookie, 'ajeno.mx'); await direccion(a.cookie, d.id, 'x');
    esperaResend('GET', '/emails/receiving/em_aj', recibido({ id: 'em_aj', para: ['x@ajeno.mx'] }));
    await webhook({ type: 'email.received', data: { email_id: 'em_aj' } });
    const mid = (await json('/api/mensajes', undefined, { cookie: a.cookie })).mensajes[0].id;
    const { client_id } = await registrarCliente();
    const code = await codigoPara(b.cookie, client_id, 'q'.repeat(50));
    const { access_token } = await token({ grant_type: 'authorization_code', code, client_id, code_verifier: 'q'.repeat(50) });
    expect((await herramienta(access_token, 'listar_dominios')).content[0].text).toBe('La cuenta no tiene dominios.');
    expect((await herramienta(access_token, 'leer_conversacion', { id: mid })).isError).toBe(true);
    expect((await herramienta(access_token, 'mover_correos', { ids: [mid], accion: 'borrar' })).structuredContent.cambiados).toBe(0);
  });
});
