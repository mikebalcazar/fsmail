import { SELF, env } from 'cloudflare:test';
import { expect, vi } from 'vitest';
import type { Env } from '../src/entorno';
import { firmar } from '../src/cartero';

export const E = env as unknown as Env;
export const BASE = 'https://fsmail.test';

export async function json(ruta: string, cuerpo?: unknown, opciones: { cookie?: string; metodo?: string; headers?: Record<string, string> } = {}) {
  const r = await SELF.fetch(BASE + ruta, {
    method: opciones.metodo ?? (cuerpo === undefined ? 'GET' : 'POST'),
    headers: { ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opciones.cookie ? { Cookie: opciones.cookie } : {}), ...(opciones.headers ?? {}) },
    body: cuerpo === undefined ? undefined : typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let j: any = {};
  try { j = JSON.parse(texto); } catch { j = { texto }; }
  return { estado: r.status, cookie: r.headers.get('Set-Cookie'), ...j };
}

/** Registra una cuenta y entra. Devuelve la cookie lista para mandar. */
export async function cuentaNueva(username = 'mike', correo = `${username}@ejemplo.mx`) {
  const reg = await json('/api/auth/registro', { username, correo });
  expect(reg.estado).toBe(200);
  expect(reg.codigo_prueba).toMatch(/^\d{6}$/);
  const ent = await json('/api/auth/entrar', { usuario: username, codigo: reg.codigo_prueba });
  expect(ent.estado).toBe(200);
  const cookie = ent.cookie!.split(';')[0];
  return { cookie, cuenta: ent.cuenta as { id: string; username: string } };
}

/* ─── Lo de fuera, de mentira ───
 * Las pruebas no dejan salir a internet: cada llamada que el Worker haga por
 * `fetch` tiene que estar anunciada antes con esperaResend/esperaUrl, y al
 * terminar cada prueba no debe quedar ninguna sin consumir. Igual que la
 * suite con el SAT (vi.spyOn sobre globalThis.fetch: SELF corre en este
 * mismo aislado). */
export interface Capturada { headers: Record<string, string>; bytes: Uint8Array }
interface Esperada { metodo: string; url: string; responder: (cuerpo: string, req?: Capturada) => Response | Promise<Response> }
const esperadas: Esperada[] = [];
let instalado = false;
export function fetchDeMentira() {
  if (instalado) return; instalado = true;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (entrada: any, init?: any) => {
    const req = new Request(entrada, init);
    const i = esperadas.findIndex((e) => e.metodo === req.method && e.url === req.url);
    if (i < 0) throw new Error(`la prueba no deja salir a ${req.method} ${req.url}`);
    const [e] = esperadas.splice(i, 1);
    // Se lee todo aquí (dentro del Worker): la prueba no puede leer streams de otro contexto.
    const bytes = new Uint8Array(await req.arrayBuffer());
    return e.responder(new TextDecoder().decode(bytes), { headers: Object.fromEntries(req.headers), bytes });
  });
}
export function sinPendientes() {
  const quedan = esperadas.splice(0).map((e) => `${e.metodo} ${e.url}`);
  expect(quedan, 'llamadas anunciadas que el Worker no hizo').toEqual([]);
}
/** Anuncia una llamada a api.resend.com y qué contesta. `capturar` recibe el cuerpo que mandó el Worker. */
export function esperaResend(metodo: string, ruta: string, respuesta: unknown, opciones: { estado?: number; capturar?: (cuerpo: any) => void } = {}) {
  esperadas.push({ metodo, url: `https://api.resend.com${ruta}`, responder: (cuerpo) => {
    if (opciones.capturar) opciones.capturar(cuerpo ? JSON.parse(cuerpo) : null);
    return new Response(JSON.stringify(respuesta), { status: opciones.estado ?? 200, headers: { 'Content-Type': 'application/json' } });
  } });
}
/** Anuncia una llamada a cualquier URL. `capturar` recibe la petición completa (cabeceras y cuerpo binario). */
export function esperaUrl(metodo: string, url: string, cuerpo: string, headers: Record<string, string> = {}, estado = 200, capturar?: (req: Capturada) => void) {
  esperadas.push({ metodo, url, responder: (_t, req) => { if (capturar && req) capturar(req); return new Response(cuerpo, { status: estado, headers }); } });
}

export const registrosResend = (dominio: string) => [
  { record: 'DKIM', name: `resend._domainkey.${dominio}`, type: 'TXT', value: 'p=MIIB…', ttl: 'Auto', status: 'not_started' },
  { record: 'SPF', name: `send.${dominio}`, type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10, ttl: 'Auto', status: 'not_started' },
  { record: 'SPF', name: `send.${dominio}`, type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', ttl: 'Auto', status: 'not_started' },
  { record: 'MX', name: dominio, type: 'MX', value: 'receive.forge.rmta.net', priority: 10, ttl: 'Auto', status: 'not_started' },
];

/** Da de alta un dominio con Resend de mentira y lo marca verificado directo en D1. */
export async function dominioVerificado(cookie: string, dominio: string) {
  esperaResend('GET', '/domains', { data: [] });
  esperaResend('POST', '/domains', { id: `rs_${dominio}`, name: dominio, status: 'not_started', records: registrosResend(dominio) });
  const r = await json('/api/dominios', { dominio }, { cookie });
  expect(r.estado).toBe(201);
  await E.DB.prepare(`UPDATE dominios SET estado = 'verificado' WHERE id = ?`).bind(r.dominio.id).run();
  return r.dominio as { id: string; dominio: string };
}

export async function direccion(cookie: string, dominio_id: string, local: string, nombre?: string) {
  const r = await json(`/api/dominios/${dominio_id}/direcciones`, { local, nombre }, { cookie });
  expect(r.estado).toBe(201);
  return r.direccion as { id: string; correo: string };
}

/** Manda un webhook email.received firmado como lo haría Resend. */
export async function webhook(cuerpo: unknown, opciones: { secreto?: string; ts?: string } = {}) {
  const texto = JSON.stringify(cuerpo);
  const id = `msg_${crypto.randomUUID()}`;
  const ts = opciones.ts ?? String(Math.floor(Date.now() / 1000));
  const firma = await firmar(opciones.secreto ?? E.RESEND_WEBHOOK_SECRET!, id, ts, texto);
  return json('/webhook/resend', texto, { headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': firma, 'Content-Type': 'application/json' } });
}

/** Un correo recibido como lo devuelve GET /emails/receiving/{id}. */
export function recibido(p: { id: string; de?: string; para: string[]; asunto?: string; texto?: string; html?: string | null; message_id?: string; in_reply_to?: string; adjuntos?: any[]; cc?: string[]; received_for?: string[]; creado?: string }) {
  const headers: Record<string, string> = { from: p.de ?? 'Cliente Uno <cliente@gmail.com>', to: p.para.join(', '), subject: p.asunto ?? 'Cotización', date: p.creado ? new Date(p.creado).toUTCString() : 'Wed, 22 Oct 2026 10:00:00 +0000', 'message-id': p.message_id ?? `<${p.id}@gmail.com>` };
  if (p.in_reply_to) { headers['in-reply-to'] = p.in_reply_to; headers['references'] = p.in_reply_to; }
  return {
    object: 'email', id: p.id, created_at: p.creado ?? '2026-10-22T10:00:01.000Z', message_id: p.message_id ?? `<${p.id}@gmail.com>`,
    from: (p.de ?? 'cliente@gmail.com').replace(/^.*<|>$/g, ''), to: p.para, cc: p.cc ?? [], bcc: [], reply_to: null, received_for: p.received_for ?? [],
    subject: p.asunto ?? 'Cotización', text: p.texto ?? 'Hola, ¿me pasan precio?', html: p.html === undefined ? '<p>Hola, <b>¿me pasan precio?</b></p>' : p.html,
    headers, authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, raw: null, attachments: p.adjuntos ?? [],
  };
}
