/* Cuentas y sesiones. Registro público con username; se entra con un código
 * de seis dígitos que llega al correo de la cuenta. La sesión es una cookie
 * HttpOnly `fsm` cuyo valor sólo existe hasheado en D1. */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { Cuenta, Env, Variables } from './entorno';
import { ahora, cookie, correoValido, enSegundos, id, igualSeguro, leerCookie, sha256, tokenAleatorio, usernameValido, vencida } from './lib';
import { devuelveCodigo, mandarCodigo } from './correo';

type App = { Bindings: Env; Variables: Variables };
export const VIDA_SESION = 60 * 60 * 24 * 30; // 30 días
const VIDA_CODIGO = 60 * 10;
const MAX_INTENTOS = 5;
const PAUSA_REENVIO = 30;

export const err = (c: Context, error: string, estado: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503, extra: Record<string, unknown> = {}) =>
  c.json({ ok: false, error, ...extra }, estado);

export async function cuentaDeSesion(env: Env, cabeceraCookie: string | undefined): Promise<{ cuenta: Cuenta; sesion: string } | null> {
  const valor = leerCookie(cabeceraCookie);
  if (!valor) return null;
  const h = await sha256(valor);
  const fila = await env.DB.prepare(
    `SELECT c.*, s.expira_at FROM sesiones s JOIN cuentas c ON c.id = s.cuenta_id WHERE s.id_hash = ?`,
  ).bind(h).first<Cuenta & { expira_at: string }>();
  if (!fila || vencida(fila.expira_at)) return null;
  const { expira_at: _e, ...cuenta } = fila;
  return { cuenta, sesion: h };
}

/** Middleware: exige sesión y deja la cuenta en el contexto. */
export async function conSesion(c: Context<App>, next: Next) {
  const s = await cuentaDeSesion(c.env, c.req.header('Cookie'));
  if (!s) return err(c, 'sin_sesion', 401);
  c.set('cuenta', s.cuenta);
  c.set('sesion', s.sesion);
  await next();
}

async function emitirCodigo(c: Context<App>, cuenta: Cuenta) {
  const previo = await c.env.DB.prepare(`SELECT enviado_at FROM codigos WHERE correo = ?`).bind(cuenta.correo).first<{ enviado_at: string }>();
  if (previo && Date.now() - Date.parse(previo.enviado_at) < PAUSA_REENVIO * 1000) return err(c, 'espera_para_reenviar', 429, { segundos: PAUSA_REENVIO });
  const codigo = String(Math.floor(100000 + Math.random() * 900000));
  const hash = await sha256(`${codigo}|${cuenta.correo}`);
  await c.env.DB.prepare(
    `INSERT INTO codigos (correo, hash, expira_at, intentos, enviado_at) VALUES (?,?,?,0,?)
     ON CONFLICT(correo) DO UPDATE SET hash = excluded.hash, expira_at = excluded.expira_at, intentos = 0, enviado_at = excluded.enviado_at`,
  ).bind(cuenta.correo, hash, enSegundos(VIDA_CODIGO), ahora()).run();
  const envio = await mandarCodigo(c.env, cuenta.correo, codigo, cuenta.username);
  return c.json({ ok: true, enviado: envio.enviado, motivo: envio.motivo, correo_pista: pista(cuenta.correo), ...(devuelveCodigo(c.env) ? { codigo_prueba: codigo } : {}) });
}

/** mike@forespot.com → m***@forespot.com */
const pista = (correo: string) => { const [u, d] = correo.split('@'); return `${u[0]}***@${d}`; };

async function buscarCuenta(env: Env, usuario: string): Promise<Cuenta | null> {
  const u = usuario.trim().toLowerCase();
  if (!u) return null;
  return env.DB.prepare(`SELECT * FROM cuentas WHERE username = ? OR correo = ?`).bind(u, u).first<Cuenta>();
}

export const rutasAuth = new Hono<App>();

rutasAuth.post('/registro', async (c) => {
  const b = await c.req.json<{ username?: string; correo?: string; nombre?: string }>().catch(() => ({}) as { username?: string; correo?: string; nombre?: string });
  const username = String(b.username ?? '').trim().toLowerCase();
  const correo = String(b.correo ?? '').trim().toLowerCase();
  if (!usernameValido(username)) return err(c, 'username_invalido', 400, { regla: 'de 3 a 32: letras minúsculas, números, punto, guion y guion bajo' });
  if (!correoValido(correo)) return err(c, 'correo_invalido', 400);
  const choque = await c.env.DB.prepare(`SELECT username, correo FROM cuentas WHERE username = ? OR correo = ?`).bind(username, correo).first<{ username: string; correo: string }>();
  if (choque) return err(c, choque.username === username ? 'username_ocupado' : 'correo_ocupado', 409);
  const cuenta: Cuenta = { id: id(), username, correo, nombre: b.nombre ? String(b.nombre).trim().slice(0, 80) : null, creada_at: ahora() };
  await c.env.DB.prepare(`INSERT INTO cuentas (id, username, correo, nombre, creada_at) VALUES (?,?,?,?,?)`)
    .bind(cuenta.id, cuenta.username, cuenta.correo, cuenta.nombre, cuenta.creada_at).run();
  return emitirCodigo(c, cuenta);
});

rutasAuth.post('/codigo', async (c) => {
  const b = await c.req.json<{ usuario?: string }>().catch(() => ({}) as { usuario?: string });
  const cuenta = await buscarCuenta(c.env, String(b.usuario ?? ''));
  // La misma respuesta exista o no: no se regala quién tiene cuenta.
  if (!cuenta) return c.json({ ok: true, enviado: false, correo_pista: null });
  return emitirCodigo(c, cuenta);
});

rutasAuth.post('/entrar', async (c) => {
  const b = await c.req.json<{ usuario?: string; codigo?: string }>().catch(() => ({}) as { usuario?: string; codigo?: string });
  const cuenta = await buscarCuenta(c.env, String(b.usuario ?? ''));
  const codigo = String(b.codigo ?? '').replace(/\D/g, '');
  if (!cuenta || codigo.length !== 6) return err(c, 'codigo_invalido', 401);
  const fila = await c.env.DB.prepare(`SELECT * FROM codigos WHERE correo = ?`).bind(cuenta.correo).first<{ hash: string; expira_at: string; intentos: number }>();
  if (!fila) return err(c, 'codigo_invalido', 401);
  if (vencida(fila.expira_at)) return err(c, 'codigo_invalido', 401, { motivo: 'vencido' });
  if (fila.intentos >= MAX_INTENTOS) return err(c, 'codigo_invalido', 401, { motivo: 'demasiados_intentos' });
  const hash = await sha256(`${codigo}|${cuenta.correo}`);
  if (!igualSeguro(hash, fila.hash)) {
    await c.env.DB.prepare(`UPDATE codigos SET intentos = intentos + 1 WHERE correo = ?`).bind(cuenta.correo).run();
    return err(c, 'codigo_invalido', 401, { intentos_restantes: MAX_INTENTOS - fila.intentos - 1 });
  }
  await c.env.DB.prepare(`DELETE FROM codigos WHERE correo = ?`).bind(cuenta.correo).run();
  const valor = tokenAleatorio();
  await c.env.DB.prepare(`INSERT INTO sesiones (id_hash, cuenta_id, creada_at, expira_at) VALUES (?,?,?,?)`)
    .bind(await sha256(valor), cuenta.id, ahora(), enSegundos(VIDA_SESION)).run();
  c.header('Set-Cookie', cookie(valor, VIDA_SESION));
  return c.json({ ok: true, cuenta: publica(cuenta) });
});

rutasAuth.post('/salir', async (c) => {
  const s = await cuentaDeSesion(c.env, c.req.header('Cookie'));
  if (s) await c.env.DB.prepare(`DELETE FROM sesiones WHERE id_hash = ?`).bind(s.sesion).run();
  c.header('Set-Cookie', cookie('', 0));
  return c.json({ ok: true });
});

export const publica = (cu: Cuenta) => ({ id: cu.id, username: cu.username, correo: cu.correo, nombre: cu.nombre });
