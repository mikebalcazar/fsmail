/* Las bandejas: listar por dominio y dirección, leer un mensaje (del R2),
 * marcar, mover, bajar adjuntos, y enviar o responder desde una dirección
 * de un dominio verificado. */

import { Hono } from 'hono';
import type { Adjunto, Direccion, Dominio, Env, Mensaje, Variables } from './entorno';
import { ahora, correoValido, id, resumenDe } from './lib';
import { ErrorCartero, enviar } from './cartero';
import { err } from './auth';
import { hiloPara, llaveAdjunto, llaveMensaje } from './webhook';
import { firmaDeDireccion } from './dominios';
import { textoAHtml } from './firma';

type App = { Bindings: Env; Variables: Variables };
export const rutasMensajes = new Hono<App>();
const CARPETAS = ['entrada', 'enviados', 'archivo', 'basura'] as const;

const ficha = (m: Mensaje) => ({
  id: m.id, dominio_id: m.dominio_id, direccion_id: m.direccion_id, hilo_id: m.hilo_id, de: m.de, de_nombre: m.de_nombre, para: JSON.parse(m.para || '[]'),
  asunto: m.asunto, resumen: m.resumen, fecha: m.fecha, carpeta: m.carpeta, leido: !!m.leido, adjuntos: m.adjuntos, message_id: m.message_id,
});

/** Conteos para el árbol: por dominio y por dirección, sin leer y total (entrada). */
rutasMensajes.get('/conteos', async (c) => {
  const cu = c.get('cuenta');
  const filas = (await c.env.DB.prepare(
    `SELECT dominio_id, direccion_id, COUNT(*) AS total, SUM(CASE WHEN leido = 0 THEN 1 ELSE 0 END) AS sin_leer
       FROM mensajes WHERE cuenta_id = ? AND carpeta = 'entrada' GROUP BY dominio_id, direccion_id`,
  ).bind(cu.id).all<{ dominio_id: string; direccion_id: string | null; total: number; sin_leer: number }>()).results;
  return c.json({ ok: true, conteos: filas });
});

rutasMensajes.get('/', async (c) => {
  const cu = c.get('cuenta');
  const q = c.req.query();
  const carpeta = (CARPETAS as readonly string[]).includes(q.carpeta ?? '') ? q.carpeta! : 'entrada';
  const cond: string[] = ['cuenta_id = ?', 'carpeta = ?'];
  const args: unknown[] = [cu.id, carpeta];
  if (q.dominio) { cond.push('dominio_id = ?'); args.push(q.dominio); }
  if (q.direccion === 'ninguna') cond.push('direccion_id IS NULL');
  else if (q.direccion) { cond.push('direccion_id = ?'); args.push(q.direccion); }
  if (q.hilo) { cond.push('hilo_id = ?'); args.push(q.hilo); }
  if (q.sin_leer === '1') cond.push('leido = 0');
  if (q.q) { const like = `%${q.q.trim()}%`; cond.push('(asunto LIKE ? OR de LIKE ? OR de_nombre LIKE ? OR resumen LIKE ?)'); args.push(like, like, like, like); }
  if (q.antes) { cond.push('fecha < ?'); args.push(q.antes); }
  const limite = Math.min(Math.max(Number(q.limite) || 50, 1), 200);
  const filas = (await c.env.DB.prepare(`SELECT * FROM mensajes WHERE ${cond.join(' AND ')} ORDER BY fecha DESC LIMIT ?`).bind(...args, limite + 1).all<Mensaje>()).results;
  const hayMas = filas.length > limite;
  return c.json({ ok: true, mensajes: filas.slice(0, limite).map(ficha), hay_mas: hayMas });
});

async function mensajeDe(env: Env, cuenta_id: string, mid: string) {
  return env.DB.prepare(`SELECT * FROM mensajes WHERE id = ? AND cuenta_id = ?`).bind(mid, cuenta_id).first<Mensaje>();
}

rutasMensajes.get('/:id', async (c) => {
  const cu = c.get('cuenta');
  const m = await mensajeDe(c.env, cu.id, c.req.param('id'));
  if (!m) return err(c, 'no_existe', 404);
  const obj = await c.env.CORREO.get(m.r2_llave);
  const contenido = obj ? await obj.json<Record<string, unknown>>() : null;
  const adjuntos = (await c.env.DB.prepare(`SELECT * FROM adjuntos WHERE mensaje_id = ?`).bind(m.id).all<Adjunto>()).results;
  if (!m.leido) await c.env.DB.prepare(`UPDATE mensajes SET leido = 1 WHERE id = ?`).bind(m.id).run();
  return c.json({
    ok: true, mensaje: { ...ficha(m), leido: true, autenticacion: m.autenticacion ? JSON.parse(m.autenticacion) : null },
    contenido, adjuntos: adjuntos.map((a) => ({ id: a.id, nombre: a.nombre, tipo: a.tipo, tamano: a.tamano, inline: !!a.inline, content_id: a.content_id })),
  });
});

rutasMensajes.patch('/:id', async (c) => {
  const cu = c.get('cuenta');
  const m = await mensajeDe(c.env, cu.id, c.req.param('id'));
  if (!m) return err(c, 'no_existe', 404);
  const b = await c.req.json<{ leido?: boolean; carpeta?: string }>().catch(() => ({}) as { leido?: boolean; carpeta?: string });
  const leido = typeof b.leido === 'boolean' ? (b.leido ? 1 : 0) : m.leido;
  const carpeta = b.carpeta && (CARPETAS as readonly string[]).includes(b.carpeta) ? b.carpeta : m.carpeta;
  await c.env.DB.prepare(`UPDATE mensajes SET leido = ?, carpeta = ? WHERE id = ?`).bind(leido, carpeta, m.id).run();
  return c.json({ ok: true });
});

rutasMensajes.get('/:id/adjuntos/:aid', async (c) => {
  const cu = c.get('cuenta');
  const m = await mensajeDe(c.env, cu.id, c.req.param('id'));
  if (!m) return err(c, 'no_existe', 404);
  const a = await c.env.DB.prepare(`SELECT * FROM adjuntos WHERE id = ? AND mensaje_id = ?`).bind(c.req.param('aid'), m.id).first<Adjunto>();
  if (!a) return err(c, 'no_existe', 404);
  const obj = await c.env.CORREO.get(a.r2_llave);
  if (!obj) return err(c, 'no_existe', 404);
  const nombre = (a.nombre ?? 'adjunto').replace(/["\r\n]/g, '');
  return new Response(obj.body, {
    headers: {
      'Content-Type': a.tipo ?? 'application/octet-stream',
      'Content-Disposition': `${c.req.query('ver') ? 'inline' : 'attachment'}; filename="${nombre}"`,
      'Cache-Control': 'private, max-age=3600',
    },
  });
});

/** Adjuntos al enviar: el cliente los manda en base64 dentro del JSON.
 *  Límites por debajo de los de Resend (40 MB por correo): 10 archivos,
 *  20 MB en total ya decodificados. */
export const MAX_ADJUNTOS = 10;
export const MAX_ADJUNTOS_BYTES = 20 * 1024 * 1024;
type AdjuntoEnviado = { nombre?: string; tipo?: string; contenido?: string };
type AdjuntoListo = { nombre: string; tipo: string; contenido: string; bytes: Uint8Array };
export function adjuntosLimpios(entrada: unknown): AdjuntoListo[] | 'muchos' | 'pesados' | 'invalidos' {
  if (entrada == null) return [];
  if (!Array.isArray(entrada)) return 'invalidos';
  if (entrada.length > MAX_ADJUNTOS) return 'muchos';
  const salida: AdjuntoListo[] = [];
  let total = 0;
  for (const a of entrada as AdjuntoEnviado[]) {
    const contenido = String(a?.contenido ?? '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    const nombre = String(a?.nombre ?? '').replace(/[\\/"\r\n]/g, '').trim().slice(0, 200) || 'adjunto';
    const tipo = /^[\w.+-]+\/[\w.+-]+$/.test(String(a?.tipo ?? '')) ? String(a!.tipo) : 'application/octet-stream';
    if (!contenido || !/^[A-Za-z0-9+/]+=*$/.test(contenido)) return 'invalidos';
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(contenido), (ch) => ch.charCodeAt(0)); } catch { return 'invalidos'; }
    if (!bytes.byteLength) return 'invalidos';
    total += bytes.byteLength;
    if (total > MAX_ADJUNTOS_BYTES) return 'pesados';
    salida.push({ nombre, tipo, contenido, bytes });
  }
  return salida;
}

/** Enviar (o responder) desde una dirección de un dominio verificado. */
rutasMensajes.post('/enviar', async (c) => {
  const cu = c.get('cuenta');
  const b = await c.req.json<{ direccion_id?: string; para?: string[] | string; cc?: string[]; asunto?: string; texto?: string; html?: string; en_respuesta_a?: string; adjuntos?: AdjuntoEnviado[] }>()
    .catch(() => ({}) as Record<string, never>);
  const dir = await c.env.DB.prepare(`SELECT d.*, o.dominio, o.estado, o.cuenta_id, o.marca, o.id AS dominio_id FROM direcciones d JOIN dominios o ON o.id = d.dominio_id WHERE d.id = ? AND o.cuenta_id = ?`)
    .bind(String(b.direccion_id ?? ''), cu.id).first<Direccion & { dominio: string; estado: Dominio['estado']; cuenta_id: string; marca: string }>();
  if (!dir) return err(c, 'direccion_no_existe', 404);
  if (!dir.activa) return err(c, 'direccion_inactiva', 409);
  if (dir.estado !== 'verificado') return err(c, 'dominio_sin_verificar', 409);
  const para = (Array.isArray(b.para) ? b.para : String(b.para ?? '').split(/[,;\s]+/)).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const cc = (Array.isArray(b.cc) ? b.cc : []).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!para.length || ![...para, ...cc].every(correoValido)) return err(c, 'destinatario_invalido', 400);
  const asunto = String(b.asunto ?? '').trim().slice(0, 998);
  const texto = String(b.texto ?? '');
  if (!texto.trim() && !b.html) return err(c, 'mensaje_vacio', 400);
  const adjuntos = adjuntosLimpios(b.adjuntos);
  if (adjuntos === 'muchos') return err(c, 'adjuntos_demasiados', 400, { maximo: MAX_ADJUNTOS });
  if (adjuntos === 'pesados') return err(c, 'adjuntos_pesados', 400, { maximo_bytes: MAX_ADJUNTOS_BYTES });
  if (adjuntos === 'invalidos') return err(c, 'adjunto_invalido', 400);

  let original: Mensaje | null = null;
  if (b.en_respuesta_a) {
    original = await mensajeDe(c.env, cu.id, String(b.en_respuesta_a));
    if (!original) return err(c, 'original_no_existe', 404);
  }
  const de = `${(dir.nombre ?? dir.local).replace(/[<>"]/g, '')} <${dir.local}@${dir.dominio}>`;
  const headers: Record<string, string> = { 'X-Entity-Ref-ID': crypto.randomUUID() };
  if (original?.message_id) { headers['In-Reply-To'] = original.message_id; headers['References'] = original.message_id; }
  // La firma de la dirección va debajo, en HTML y en texto. Si el cliente
  // mandó su propio HTML, se le pega la firma al final.
  const firma = firmaDeDireccion(c.env, dir, { id: dir.dominio_id, dominio: dir.dominio, marca: dir.marca } as Dominio);
  const textoFinal = firma.hay ? `${texto.trimEnd()}\n\n${firma.texto}` : texto;
  const htmlFinal = b.html ? `${String(b.html)}${firma.html}` : firma.hay ? `${textoAHtml(texto)}${firma.html}` : undefined;
  let envio: { id: string };
  try {
    envio = await enviar(c.env, { from: de, to: para, ...(cc.length ? { cc } : {}), subject: asunto, text: textoFinal, ...(htmlFinal ? { html: htmlFinal } : {}), headers,
      ...(adjuntos.length ? { attachments: adjuntos.map((a) => ({ filename: a.nombre, content: a.contenido, content_type: a.tipo })) } : {}) });
  } catch (e) {
    if (e instanceof ErrorCartero) return err(c, e.estado === 503 ? 'correo_no_configurado' : 'cartero_fallo', 503, { detalle: e.cuerpo.slice(0, 300) });
    throw e;
  }
  const mid = id();
  const fecha = ahora();
  const hilo_id = original ? original.hilo_id : await hiloPara(c.env, cu.id, [], asunto);
  const contenido = { html: htmlFinal ?? null, text: textoFinal, headers: { from: de, to: para.join(', '), ...(cc.length ? { cc: cc.join(', ') } : {}), subject: asunto, ...(original?.message_id ? { 'in-reply-to': original.message_id } : {}) }, from: de, to: para, cc, subject: asunto, resend_id: envio.id };
  const r2 = llaveMensaje(cu.id, mid);
  await c.env.CORREO.put(r2, JSON.stringify(contenido), { httpMetadata: { contentType: 'application/json' } });
  // Los adjuntos que salieron se guardan igual que los que llegan, para verlos en «enviados».
  const filasAdj: D1PreparedStatement[] = [];
  for (const a of adjuntos) {
    const aid = id();
    const llave = llaveAdjunto(cu.id, mid, aid);
    await c.env.CORREO.put(llave, a.bytes, { httpMetadata: { contentType: a.tipo } });
    filasAdj.push(c.env.DB.prepare(`INSERT INTO adjuntos (id, mensaje_id, nombre, tipo, tamano, content_id, inline, r2_llave) VALUES (?,?,?,?,?,NULL,0,?)`).bind(aid, mid, a.nombre, a.tipo, a.bytes.byteLength, llave));
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO mensajes (id, cuenta_id, dominio_id, direccion_id, hilo_id, resend_id, message_id, en_respuesta_a, de, de_nombre, para, asunto, resumen, fecha, carpeta, leido, adjuntos, r2_llave, tamano, autenticacion, creada_at)
       VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,'enviados',1,?,?,?,NULL,?)`,
    ).bind(mid, cu.id, dir.dominio_id, dir.id, hilo_id, envio.id, original?.message_id ?? null, `${dir.local}@${dir.dominio}`, dir.nombre, JSON.stringify(para), asunto, resumenDe(texto, b.html ?? null), fecha, adjuntos.length, r2, texto.length, fecha),
    c.env.DB.prepare(`UPDATE hilos SET ultimo_at = ?, mensajes = mensajes + 1, asunto = COALESCE(asunto, ?) WHERE id = ?`).bind(fecha, asunto, hilo_id),
    ...filasAdj,
  ]);
  return c.json({ ok: true, mensaje: { id: mid, hilo_id, resend_id: envio.id, fecha } }, 201);
});
