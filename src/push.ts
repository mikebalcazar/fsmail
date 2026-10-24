/* Notificaciones Web Push sin librerías: cifrado del mensaje (RFC 8291,
 * aes128gcm), firma VAPID (RFC 8292) y envío al servicio de push del
 * navegador (RFC 8030). Las llaves VAPID son un par por instalación, lo
 * genera el Worker la primera vez y vive en D1 (tabla `vapid`): nadie las
 * maneja a mano. Cada navegador que acepta queda como una suscripción de la
 * cuenta; se borra sola cuando el servicio contesta 404/410. */

import { Hono } from 'hono';
import type { Env, Variables } from './entorno';
import { ahora, id, partirRemitente } from './lib';
import { err } from './auth';

type App = { Bindings: Env; Variables: Variables };
export const rutasPush = new Hono<App>();

export interface Suscripcion { id: string; cuenta_id: string; endpoint: string; p256dh: string; auth: string; agente: string | null; creada_at: string; ultimo_envio: string | null; ultimo_error: string | null }

// ── utilería de bytes ──
export const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const deB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const te = (s: string) => new TextEncoder().encode(s);
const concat = (...partes: Uint8Array[]) => { const out = new Uint8Array(partes.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of partes) { out.set(p, o); o += p.length; } return out; };
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}

// ── llaves VAPID ──
export async function llavesVapid(env: Env, intento = 0): Promise<{ publica: string; privadaJwk: JsonWebKey }> {
  const fila = await env.DB.prepare(`SELECT publica, privada FROM vapid WHERE id = 1`).first<{ publica: string; privada: string }>();
  if (fila) return { publica: fila.publica, privadaJwk: JSON.parse(fila.privada) as JsonWebKey };
  if (intento > 0) throw new Error('no se pudieron crear las llaves VAPID');
  const par = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publica = b64u((await crypto.subtle.exportKey('raw', par.publicKey)) as ArrayBuffer);
  const privada = JSON.stringify(await crypto.subtle.exportKey('jwk', par.privateKey));
  // Si dos peticiones llegan a la vez, gana la primera y la segunda relee.
  await env.DB.prepare(`INSERT OR IGNORE INTO vapid (id, publica, privada, creada_at) VALUES (1, ?, ?, ?)`).bind(publica, privada, ahora()).run();
  return llavesVapid(env, intento + 1);
}

/** Cabecera Authorization para el servicio de push: JWT ES256 con la
 *  audiencia (origen del endpoint), 12 h de vigencia y nuestro contacto. */
export async function cabeceraVapid(env: Env, endpoint: string): Promise<string> {
  const { publica, privadaJwk } = await llavesVapid(env);
  const llave = await crypto.subtle.importKey('jwk', privadaJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const contacto = partirRemitente(env.CORREO_REMITENTE).correo;
  const parte = (o: unknown) => b64u(te(JSON.stringify(o)));
  const sinFirma = `${parte({ typ: 'JWT', alg: 'ES256' })}.${parte({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: `mailto:${contacto}` })}`;
  const firma = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, llave, te(sinFirma));
  return `vapid t=${sinFirma}.${b64u(firma)}, k=${publica}`;
}

/** Cifra el cuerpo para una suscripción (RFC 8291): ECDH efímero con la
 *  llave del navegador + su `auth`, HKDF, AES-128-GCM, un solo registro. */
export async function cifrarPush(sub: { p256dh: string; auth: string }, textoPlano: Uint8Array): Promise<Uint8Array> {
  const uaPub = deB64u(sub.p256dh); // 65 bytes, P-256 sin comprimir
  const authSecret = deB64u(sub.auth); // 16 bytes
  if (uaPub.length !== 65 || authSecret.length !== 16) throw new Error('suscripción con llaves inválidas');
  const efimera = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPub = new Uint8Array((await crypto.subtle.exportKey('raw', efimera.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as Parameters<SubtleCrypto['deriveBits']>[0], efimera.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(authSecret, ecdh, concat(te('WebPush: info\0'), uaPub, asPub), 32);
  const cek = await hkdf(salt, ikm, te('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te('Content-Encoding: nonce\0'), 12);
  const llave = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, llave, concat(textoPlano, new Uint8Array([2])))); // 0x02: último registro
  const rs = 4096;
  const cabecera = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]), new Uint8Array([asPub.length]), asPub);
  return concat(cabecera, cifrado);
}

export interface AvisoCorreo { id: string; de: string; de_nombre: string | null; asunto: string | null; resumen: string | null; etiqueta: string; fecha: string }

/** Manda el aviso de un correo nuevo a todos los navegadores de la cuenta.
 *  Nunca lanza: devuelve cuántos salieron y cuántos fallaron. */
export async function notificarCorreo(env: Env, cuenta_id: string, m: AvisoCorreo): Promise<{ enviadas: number; fallidas: number; borradas: number }> {
  const subs = (await env.DB.prepare(`SELECT * FROM push_suscripciones WHERE cuenta_id = ?`).bind(cuenta_id).all<Suscripcion>()).results;
  if (!subs.length) return { enviadas: 0, fallidas: 0, borradas: 0 };
  const titulo = (m.de_nombre || m.de).slice(0, 80);
  const cuerpo = [m.asunto || '(sin asunto)', m.resumen || ''].filter(Boolean).join('\n').slice(0, 220);
  const carga = te(JSON.stringify({ titulo, cuerpo, id: m.id, etiqueta: m.etiqueta, url: `${env.ORIGEN}/#m=${m.id}`, cuando: m.fecha }));
  return mandarATodas(env, subs, carga);
}

async function mandarATodas(env: Env, subs: Suscripcion[], carga: Uint8Array) {
  let enviadas = 0, fallidas = 0, borradas = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const cuerpo = await cifrarPush(s, carga);
      const r = await fetch(s.endpoint, {
        method: 'POST',
        headers: { Authorization: await cabeceraVapid(env, s.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
        body: cuerpo, signal: AbortSignal.timeout(8000),
      });
      if (r.status === 404 || r.status === 410) { await env.DB.prepare(`DELETE FROM push_suscripciones WHERE id = ?`).bind(s.id).run(); borradas++; return; }
      if (!r.ok) { await env.DB.prepare(`UPDATE push_suscripciones SET ultimo_error = ? WHERE id = ?`).bind(`${r.status} ${(await r.text()).slice(0, 200)}`, s.id).run(); fallidas++; return; }
      await env.DB.prepare(`UPDATE push_suscripciones SET ultimo_envio = ?, ultimo_error = NULL WHERE id = ?`).bind(ahora(), s.id).run(); enviadas++;
    } catch (e) {
      fallidas++;
      await env.DB.prepare(`UPDATE push_suscripciones SET ultimo_error = ? WHERE id = ?`).bind(String(e instanceof Error ? e.message : e).slice(0, 200), s.id).run().catch(() => {});
    }
  }));
  return { enviadas, fallidas, borradas };
}

// ── rutas (bajo /api/push, con sesión) ──
rutasPush.get('/clave', async (c) => c.json({ ok: true, publica: (await llavesVapid(c.env)).publica }));

rutasPush.get('/estado', async (c) => {
  const cu = c.get('cuenta');
  const subs = (await c.env.DB.prepare(`SELECT id, endpoint, agente, creada_at, ultimo_envio, ultimo_error FROM push_suscripciones WHERE cuenta_id = ? ORDER BY creada_at`).bind(cu.id).all<Suscripcion>()).results;
  return c.json({ ok: true, suscripciones: subs.map((s) => ({ id: s.id, agente: s.agente, creada_at: s.creada_at, ultimo_envio: s.ultimo_envio, ultimo_error: s.ultimo_error, endpoint_fin: s.endpoint.slice(-12) })) });
});

/** Alta (o refresco) de la suscripción de este navegador: lo que devuelve
 *  `pushManager.subscribe()` tal cual, más el nombre del navegador. */
rutasPush.post('/suscribir', async (c) => {
  const cu = c.get('cuenta');
  const b = await c.req.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string }; agente?: string }>().catch(() => ({}) as Record<string, never>);
  const endpoint = String(b.endpoint ?? '');
  const p256dh = String(b.keys?.p256dh ?? ''), auth = String(b.keys?.auth ?? '');
  let valida = /^https:\/\//.test(endpoint) && endpoint.length < 2048;
  try { if (valida) valida = deB64u(p256dh).length === 65 && deB64u(auth).length === 16; } catch { valida = false; }
  if (!valida) return err(c, 'suscripcion_invalida', 400);
  const agente = String(b.agente ?? '').slice(0, 120) || null;
  // El endpoint es único: si ya existía (de esta u otra cuenta), se reasigna aquí.
  await c.env.DB.prepare(
    `INSERT INTO push_suscripciones (id, cuenta_id, endpoint, p256dh, auth, agente, creada_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET cuenta_id = excluded.cuenta_id, p256dh = excluded.p256dh, auth = excluded.auth, agente = excluded.agente, ultimo_error = NULL`,
  ).bind(id(), cu.id, endpoint, p256dh, auth, agente, ahora()).run();
  const n = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM push_suscripciones WHERE cuenta_id = ?`).bind(cu.id).first<{ n: number }>();
  return c.json({ ok: true, suscripciones: n?.n ?? 1 }, 201);
});

rutasPush.delete('/suscribir', async (c) => {
  const cu = c.get('cuenta');
  const b = await c.req.json<{ endpoint?: string }>().catch(() => ({}) as { endpoint?: string });
  const r = await c.env.DB.prepare(`DELETE FROM push_suscripciones WHERE cuenta_id = ? AND endpoint = ?`).bind(cu.id, String(b.endpoint ?? '')).run();
  return c.json({ ok: true, borradas: r.meta.changes ?? 0 });
});

/** Una notificación de prueba a todos los navegadores de la cuenta. */
rutasPush.post('/probar', async (c) => {
  const cu = c.get('cuenta');
  const subs = (await c.env.DB.prepare(`SELECT * FROM push_suscripciones WHERE cuenta_id = ?`).bind(cu.id).all<Suscripcion>()).results;
  if (!subs.length) return err(c, 'sin_suscripciones', 404);
  const r = await mandarATodas(c.env, subs, te(JSON.stringify({ titulo: 'FSMAIL', cuerpo: 'Las notificaciones funcionan en este navegador.', id: 'prueba-' + Date.now(), url: `${c.env.ORIGEN}/`, cuando: ahora() })));
  return c.json({ ok: true, ...r });
});
