/* La entrada del correo: Resend recibe en el MX del negocio y nos avisa con
 * `email.received` (sólo metadatos). Aquí se baja el mensaje completo, se
 * guardan cuerpo y adjuntos en R2, y se indexa en D1 bajo
 * cuenta → dominio → dirección. Se contesta 2xx sólo cuando todo quedó
 * guardado; con 5xx Resend reintenta, que es lo que queremos. */

import { Hono } from 'hono';
import type { Dominio, Env } from './entorno';
import { ahora, id, partirRemitente, resumenDe } from './lib';
import { firmaValida, leerAdjunto, leerRecibido, type CorreoRecibido } from './cartero';

export const rutasWebhook = new Hono<{ Bindings: Env }>();

interface EventoResend { type: string; created_at: string; data: { email_id: string; from?: string; to?: string[]; subject?: string } }

rutasWebhook.post('/resend', async (c) => {
  const cuerpo = await c.req.text();
  const ok = await firmaValida(c.env.RESEND_WEBHOOK_SECRET, {
    id: c.req.header('svix-id') ?? null, ts: c.req.header('svix-timestamp') ?? null, firma: c.req.header('svix-signature') ?? null,
  }, cuerpo);
  if (!ok) return c.json({ ok: false, error: 'firma_invalida' }, 401);
  let ev: EventoResend;
  try { ev = JSON.parse(cuerpo); } catch { return c.json({ ok: false, error: 'json_invalido' }, 400); }
  if (ev.type !== 'email.received' || !ev.data?.email_id) return c.json({ ok: true, ignorado: ev.type });
  const r = await procesarRecibido(c.env, ev.data.email_id);
  return c.json({ ok: true, ...r });
});

export const llaveMensaje = (cuenta_id: string, mensaje_id: string) => `c/${cuenta_id}/m/${mensaje_id}.json`;
export const llaveAdjunto = (cuenta_id: string, mensaje_id: string, adjunto_id: string) => `c/${cuenta_id}/m/${mensaje_id}/a/${adjunto_id}`;

/** Cabeceras como objeto en minúsculas, venga como vengan de Resend. */
export function cabeceras(h: CorreoRecibido['headers'] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (Array.isArray(h)) for (const x of h) out[String(x.name).toLowerCase()] = String(x.value);
  else for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

const soloCorreo = (s: string) => partirRemitente(s).correo;

export async function procesarRecibido(env: Env, email_id: string): Promise<{ guardados: number; motivo?: string }> {
  const ya = await env.DB.prepare(`SELECT id FROM mensajes WHERE resend_id = ?`).bind(email_id).first();
  if (ya) return { guardados: 0, motivo: 'duplicado' };

  const correo = await leerRecibido(env, email_id);
  const destinos = [...new Set([...(correo.to ?? []), ...(correo.cc ?? []), ...(correo.received_for ?? [])].map(soloCorreo).filter((x) => x.includes('@')))];
  if (!destinos.length) return { guardados: 0, motivo: 'sin_destinatarios' };

  // Qué dominios nuestros aparecen entre los destinatarios.
  const porDominio = new Map<string, string[]>();
  for (const d of destinos) { const dom = d.split('@')[1]; porDominio.set(dom, [...(porDominio.get(dom) ?? []), d]); }
  const marcas = [...porDominio.keys()];
  const dominios = marcas.length
    ? (await env.DB.prepare(`SELECT * FROM dominios WHERE dominio IN (${marcas.map(() => '?').join(',')})`).bind(...marcas).all<Dominio>()).results
    : [];
  if (!dominios.length) return { guardados: 0, motivo: 'sin_dominio' };

  const cab = cabeceras(correo.headers);
  const remitente = partirRemitente(cab['from'] ?? correo.from);
  const message_id = correo.message_id ?? cab['message-id'] ?? null;
  const en_respuesta_a = cab['in-reply-to'] ?? null;
  const referencias = [en_respuesta_a, ...(cab['references'] ?? '').split(/\s+/)].filter((x): x is string => !!x);
  const fecha = (cab['date'] && !Number.isNaN(Date.parse(cab['date']))) ? new Date(cab['date']).toISOString() : correo.created_at ?? ahora();
  const contenido = {
    html: correo.html, text: correo.text, headers: cab, from: cab['from'] ?? correo.from, to: correo.to, cc: correo.cc, reply_to: correo.reply_to,
    subject: correo.subject, authentication: correo.authentication ?? null, resend_id: correo.id,
  };
  const cuerpoJson = JSON.stringify(contenido);

  // Adjuntos: se bajan UNA vez y se copian por mensaje (si llegó a dos de
  // nuestros dominios, cada cuenta tiene el suyo completo).
  const adjuntos: Array<{ meta: CorreoRecibido['attachments'][number]; bytes: ArrayBuffer }> = [];
  for (const a of correo.attachments ?? []) {
    const info = await leerAdjunto(env, correo.id, a.id);
    const r = await fetch(info.download_url);
    if (!r.ok) throw new Error(`adjunto ${a.id}: ${r.status}`);
    adjuntos.push({ meta: { ...a, size: info.size ?? a.size }, bytes: await r.arrayBuffer() });
  }

  let guardados = 0;
  for (const dom of dominios) {
    const dirsDom = porDominio.get(dom.dominio) ?? [];
    const locales = dirsDom.map((x) => x.split('@')[0]);
    const direcciones = locales.length
      ? (await env.DB.prepare(`SELECT id, local FROM direcciones WHERE dominio_id = ? AND activa = 1 AND local IN (${locales.map(() => '?').join(',')})`).bind(dom.id, ...locales).all<{ id: string; local: string }>()).results
      : [];
    // Una fila por dirección nuestra que recibió; si ninguna está dada de
    // alta, UNA fila «sin dirección» en el dominio: nada se tira.
    const destinosAqui = direcciones.length ? direcciones.map((x) => x.id) : [null];
    for (const direccion_id of destinosAqui) {
      const mensaje_id = id();
      const hilo_id = await hiloPara(env, dom.cuenta_id, referencias, correo.subject);
      const r2 = llaveMensaje(dom.cuenta_id, mensaje_id);
      await env.CORREO.put(r2, cuerpoJson, { httpMetadata: { contentType: 'application/json' } });
      const filasAdj: D1PreparedStatement[] = [];
      for (const a of adjuntos) {
        const aid = id();
        const llave = llaveAdjunto(dom.cuenta_id, mensaje_id, aid);
        await env.CORREO.put(llave, a.bytes, { httpMetadata: { contentType: a.meta.content_type ?? 'application/octet-stream' } });
        filasAdj.push(env.DB.prepare(`INSERT INTO adjuntos (id, mensaje_id, nombre, tipo, tamano, content_id, inline, r2_llave) VALUES (?,?,?,?,?,?,?,?)`)
          .bind(aid, mensaje_id, a.meta.filename, a.meta.content_type, a.meta.size ?? a.bytes.byteLength, a.meta.content_id, a.meta.content_disposition === 'inline' ? 1 : 0, llave));
      }
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO mensajes (id, cuenta_id, dominio_id, direccion_id, hilo_id, resend_id, message_id, en_respuesta_a, de, de_nombre, para, asunto, resumen, fecha, carpeta, leido, adjuntos, r2_llave, tamano, autenticacion, creada_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'entrada',0,?,?,?,?,?)`,
        ).bind(
          mensaje_id, dom.cuenta_id, dom.id, direccion_id, hilo_id,
          // resend_id es UNIQUE: el mismo correo en dos filas lleva sufijo en la segunda.
          guardados === 0 ? correo.id : `${correo.id}#${guardados}`,
          message_id, en_respuesta_a, remitente.correo, remitente.nombre, JSON.stringify(dirsDom), correo.subject, resumenDe(correo.text, correo.html), fecha,
          adjuntos.length, r2, cuerpoJson.length, correo.authentication ? JSON.stringify(correo.authentication) : null, ahora(),
        ),
        ...filasAdj,
        env.DB.prepare(`UPDATE hilos SET ultimo_at = MAX(ultimo_at, ?), mensajes = mensajes + 1, asunto = COALESCE(asunto, ?) WHERE id = ?`).bind(fecha, correo.subject, hilo_id),
      ]);
      guardados++;
    }
  }
  return { guardados };
}

/** El hilo al que pertenece: el de cualquier mensaje de la cuenta cuyo
 *  Message-ID esté en In-Reply-To/References; si no, uno nuevo. */
export async function hiloPara(env: Env, cuenta_id: string, referencias: string[], asunto: string | null): Promise<string> {
  const refs = [...new Set(referencias.filter(Boolean))].slice(0, 20);
  if (refs.length) {
    const h = await env.DB.prepare(`SELECT hilo_id FROM mensajes WHERE cuenta_id = ? AND message_id IN (${refs.map(() => '?').join(',')}) ORDER BY fecha DESC LIMIT 1`)
      .bind(cuenta_id, ...refs).first<{ hilo_id: string }>();
    if (h) return h.hilo_id;
  }
  const hid = id();
  await env.DB.prepare(`INSERT INTO hilos (id, cuenta_id, asunto, ultimo_at, mensajes) VALUES (?,?,?,?,0)`).bind(hid, cuenta_id, asunto, ahora()).run();
  return hid;
}
