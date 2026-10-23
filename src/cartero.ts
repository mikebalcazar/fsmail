/* El cartero: Resend. Único lugar que habla con api.resend.com. Si un día se
 * cambia de proveedor (servidor propio, SES…), se cambia aquí y las bandejas
 * no se enteran (decisión de Mike, 17-oct-2026: Resend con la cuenta
 * existente de la suite; el cartero va detrás de un módulo). */

import type { Env } from './entorno';

export interface RegistroDNS { record: string; name: string; type: string; value: string; ttl?: string; status?: string; priority?: number }
export interface DominioResend { id: string; name: string; status: string; records: RegistroDNS[]; capabilities?: { sending?: string; receiving?: string } }
export interface AdjuntoRecibido { id: string; filename: string | null; content_type: string | null; content_disposition: string | null; content_id: string | null; size?: number }
export interface CorreoRecibido {
  id: string; created_at: string; message_id: string | null; from: string; to: string[]; cc: string[]; bcc: string[]; reply_to: string[] | null;
  received_for?: string[]; subject: string | null; text: string | null; html: string | null; headers: Record<string, string> | Array<{ name: string; value: string }>;
  authentication?: { spf?: string; dkim?: string; dmarc?: string } | null; raw?: { download_url: string; expires_at: string } | null; attachments: AdjuntoRecibido[];
}

export class ErrorCartero extends Error {
  constructor(public estado: number, public cuerpo: string, public operacion: string) { super(`resend ${operacion} → ${estado}: ${cuerpo.slice(0, 300)}`); }
}

function llave(env: Env): string {
  if (!env.RESEND_API_KEY) throw new ErrorCartero(503, 'correo_no_configurado', 'llave');
  return env.RESEND_API_KEY;
}

async function pedir<T>(env: Env, metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
  const r = await fetch(`${env.RESEND_BASE}${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${llave(env)}`, 'Content-Type': 'application/json' },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  if (!r.ok) throw new ErrorCartero(r.status, texto, `${metodo} ${ruta}`);
  return (texto ? JSON.parse(texto) : {}) as T;
}

/** Da de alta un dominio del negocio para recibir Y enviar. Devuelve los
 *  registros DNS que el dueño debe poner (DKIM, SPF del retorno, MX de
 *  recepción). */
export const crearDominio = (env: Env, dominio: string) =>
  pedir<DominioResend>(env, 'POST', '/domains', { name: dominio, capabilities: { sending: 'enabled', receiving: 'enabled' } });

export const leerDominio = (env: Env, resend_id: string) => pedir<DominioResend>(env, 'GET', `/domains/${resend_id}`);

/** Los dominios de la cuenta de Resend (la lista viene en `data`). */
export const listarDominios = async (env: Env): Promise<Array<{ id: string; name: string; status: string }>> => {
  const r = await pedir<{ data?: Array<{ id: string; name: string; status: string }> } | Array<{ id: string; name: string; status: string }>>(env, 'GET', '/domains');
  return Array.isArray(r) ? r : r.data ?? [];
};

/** Un dominio que ya estaba en la cuenta (las plataformas de Mike mandan
 *  avisos con kranko.app, vigifield.app, eskolapp.com) se reusa: sólo se le
 *  prende la recepción. Mandar no cambia. */
export const habilitarRecepcion = (env: Env, resend_id: string) =>
  pedir<DominioResend>(env, 'PATCH', `/domains/${resend_id}`, { capabilities: { receiving: 'enabled' } });

/** Le pide a Resend que revise el DNS ahora. Responde rápido; el estado se
 *  lee después con leerDominio. */
export const verificarDominio = (env: Env, resend_id: string) => pedir<{ object: string; id: string }>(env, 'POST', `/domains/${resend_id}/verify`);

export const borrarDominio = (env: Env, resend_id: string) => pedir<{ deleted: boolean }>(env, 'DELETE', `/domains/${resend_id}`);

/** El mensaje completo de un correo recibido (el webhook sólo trae metadatos). */
export const leerRecibido = (env: Env, email_id: string) => pedir<CorreoRecibido>(env, 'GET', `/emails/receiving/${email_id}`);

export const leerAdjunto = (env: Env, email_id: string, adjunto_id: string) =>
  pedir<AdjuntoRecibido & { download_url: string; expires_at: string }>(env, 'GET', `/emails/receiving/${email_id}/attachments/${adjunto_id}`);

export interface Envio {
  from: string; to: string[]; cc?: string[]; bcc?: string[]; reply_to?: string[]; subject: string; text: string; html?: string;
  headers?: Record<string, string>; attachments?: Array<{ filename: string; content: string; content_type?: string }>;
}
export const enviar = (env: Env, msg: Envio) => pedir<{ id: string }>(env, 'POST', '/emails', msg);

/** Firma svix de los webhooks de Resend, sin SDK: HMAC-SHA256 de
 *  `${id}.${timestamp}.${cuerpo}` con la llave base64 que sigue a `whsec_`,
 *  comparada contra cualquiera de las firmas `v1,…` de la cabecera. Cinco
 *  minutos de tolerancia contra repeticiones. */
export async function firmaValida(secreto: string | undefined, cab: { id: string | null; ts: string | null; firma: string | null }, cuerpo: string, ahoraMs = Date.now()): Promise<boolean> {
  if (!secreto || !cab.id || !cab.ts || !cab.firma) return false;
  const t = Number(cab.ts);
  if (!Number.isFinite(t) || Math.abs(ahoraMs / 1000 - t) > 300) return false;
  let llaveBytes: Uint8Array;
  try { llaveBytes = Uint8Array.from(atob(secreto.replace(/^whsec_/, '')), (c) => c.charCodeAt(0)); } catch { return false; }
  const k = await crypto.subtle.importKey('raw', llaveBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const f = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${cab.id}.${cab.ts}.${cuerpo}`));
  const esperada = btoa(String.fromCharCode(...new Uint8Array(f)));
  return cab.firma.split(' ').some((p) => {
    const [v, s] = p.split(',');
    return v === 'v1' && !!s && s.length === esperada.length && igual(s, esperada);
  });
}
function igual(a: string, b: string) { let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

/** Para las pruebas: firma un cuerpo como lo haría Resend. */
export async function firmar(secreto: string, id: string, ts: string, cuerpo: string): Promise<string> {
  const llaveBytes = Uint8Array.from(atob(secreto.replace(/^whsec_/, '')), (c) => c.charCodeAt(0));
  const k = await crypto.subtle.importKey('raw', llaveBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const f = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${id}.${ts}.${cuerpo}`));
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(f)))}`;
}
