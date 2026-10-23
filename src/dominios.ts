/* Dominios de los negocios y sus direcciones. El alta en Resend devuelve los
 * registros DNS que el dueño pone en SU DNS; nunca se le pide mover el DNS. */

import { Hono } from 'hono';
import type { Direccion, Dominio, Env, Variables } from './entorno';
import { ahora, dominioLimpio, id, localValido } from './lib';
import { ErrorCartero, borrarDominio, crearDominio, habilitarRecepcion, leerDominio, listarDominios, verificarDominio, type DominioResend } from './cartero';
import { err } from './auth';
import { anotar } from './webhook';
import { armarFirma, firmaDe, marcaDe, sitioLimpio, type Firma, type Marca } from './firma';

type App = { Bindings: Env; Variables: Variables };
export const rutasDominios = new Hono<App>();

export const dominioPublico = (d: Dominio) => ({
  id: d.id, dominio: d.dominio, estado: d.estado, registros: JSON.parse(d.registros || '[]'), catch_all: !!d.catch_all, creada_at: d.creada_at, verificada_at: d.verificada_at,
  marca: marcaDe(d),
});
export const direccionPublica = (x: Direccion, dominio: string) => ({ id: x.id, dominio_id: x.dominio_id, local: x.local, nombre: x.nombre, activa: !!x.activa, correo: `${x.local}@${dominio}`, firma: firmaDe(x) });

/** La firma de una dirección, lista para pegar. */
export function firmaDeDireccion(env: Env, x: Direccion, d: Dominio) {
  return armarFirma({ local: x.local, dominio: d.dominio, dominio_id: d.id, marca: marcaDe(d), firma: firmaDe(x), origen: env.ORIGEN });
}

const limpiarFirma = (f: unknown): Firma => {
  const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
  const t = (k: string, max: number) => { const v = String(o[k] ?? '').trim().slice(0, max); return v || undefined; };
  return { nombre: t('nombre', 80), puesto: t('puesto', 80), telefono: t('telefono', 30), extra: t('extra', 160) };
};

/** Lo que Resend dice del dominio → estado y registros nuestros. Resend
 *  reporta `verified`, `pending`, `failed`, `not_started`, `temporary_failure`. */
function estadoDe(r: DominioResend): Dominio['estado'] {
  if (r.status === 'verified') return 'verificado';
  if (r.status === 'failed') return 'fallido';
  return 'pendiente';
}

async function dominioDe(c: { env: Env; get: (k: 'cuenta') => { id: string } }, dominio_id: string): Promise<Dominio | null> {
  return c.env.DB.prepare(`SELECT * FROM dominios WHERE id = ? AND cuenta_id = ?`).bind(dominio_id, c.get('cuenta').id).first<Dominio>();
}

function erroresCartero(c: Parameters<typeof err>[0], e: unknown) {
  if (e instanceof ErrorCartero) {
    if (e.estado === 503) return err(c, 'correo_no_configurado', 503);
    return err(c, 'cartero_fallo', 503, { detalle: e.cuerpo.slice(0, 300), estado_cartero: e.estado });
  }
  throw e;
}

rutasDominios.get('/', async (c) => {
  const cu = c.get('cuenta');
  const doms = (await c.env.DB.prepare(`SELECT * FROM dominios WHERE cuenta_id = ? ORDER BY creada_at`).bind(cu.id).all<Dominio>()).results;
  const dirs = (await c.env.DB.prepare(`SELECT d.* FROM direcciones d JOIN dominios o ON o.id = d.dominio_id WHERE o.cuenta_id = ? ORDER BY d.local`).bind(cu.id).all<Direccion>()).results;
  return c.json({ ok: true, dominios: doms.map((d) => ({ ...dominioPublico(d), direcciones: dirs.filter((x) => x.dominio_id === d.id).map((x) => direccionPublica(x, d.dominio)) })) });
});

rutasDominios.post('/', async (c) => {
  const cu = c.get('cuenta');
  const b = await c.req.json<{ dominio?: string }>().catch(() => ({}) as { dominio?: string });
  const dominio = dominioLimpio(b.dominio);
  if (!dominio) return err(c, 'dominio_invalido', 400);
  const ocupado = await c.env.DB.prepare(`SELECT cuenta_id FROM dominios WHERE dominio = ?`).bind(dominio).first<{ cuenta_id: string }>();
  if (ocupado) return err(c, ocupado.cuenta_id === cu.id ? 'dominio_ya_agregado' : 'dominio_de_otra_cuenta', 409);
  let r: DominioResend & { reusado: boolean };
  try { r = await darDeAltaOReusar(c.env, dominio); } catch (e) { return erroresCartero(c, e); }
  const reusado = r.reusado;
  const d: Dominio = { id: id(), cuenta_id: cu.id, dominio, resend_id: r.id, estado: estadoDe(r), registros: JSON.stringify(r.records ?? []), catch_all: 0, creada_at: ahora(), verificada_at: estadoDe(r) === 'verificado' ? ahora() : null, marca: '{}' };
  await c.env.DB.prepare(`INSERT INTO dominios (id, cuenta_id, dominio, resend_id, estado, registros, catch_all, creada_at) VALUES (?,?,?,?,?,?,0,?)`)
    .bind(d.id, d.cuenta_id, d.dominio, d.resend_id, d.estado, d.registros, d.creada_at).run();
  return c.json({ ok: true, dominio: { ...dominioPublico(d), direcciones: [] }, reusado }, 201);
});

/** Da de alta el dominio en Resend o, si ya estaba en la cuenta (porque una
 *  plataforma manda avisos con él), lo reusa y le prende la recepción. */
export async function darDeAltaOReusar(env: Env, dominio: string): Promise<DominioResend & { reusado: boolean }> {
  const previo = (await listarDominios(env)).find((x) => x.name === dominio);
  if (previo) {
    await habilitarRecepcion(env, previo.id).catch((e) => { if (!(e instanceof ErrorCartero && e.estado < 500)) throw e; });
    const r = await leerDominio(env, previo.id);
    return { ...r, reusado: true };
  }
  return { ...(await crearDominio(env, dominio)), reusado: false };
}

/** Le pide a Resend que revise el DNS y trae el estado nuevo. */
rutasDominios.post('/:id/verificar', async (c) => {
  const d = await dominioDe(c, c.req.param('id'));
  if (!d || !d.resend_id) return err(c, 'no_existe', 404);
  let r: DominioResend;
  try {
    await verificarDominio(c.env, d.resend_id).catch(() => undefined); // si ya está verificado Resend puede contestar 4xx; el GET manda
    r = await leerDominio(c.env, d.resend_id);
  } catch (e) { return erroresCartero(c, e); }
  const estado = estadoDe(r);
  const verificada_at = estado === 'verificado' ? d.verificada_at ?? ahora() : d.verificada_at;
  await c.env.DB.prepare(`UPDATE dominios SET estado = ?, registros = ?, verificada_at = ? WHERE id = ?`).bind(estado, JSON.stringify(r.records ?? []), verificada_at, d.id).run();
  return c.json({ ok: true, dominio: dominioPublico({ ...d, estado, registros: JSON.stringify(r.records ?? []), verificada_at }) });
});

rutasDominios.patch('/:id', async (c) => {
  const d = await dominioDe(c, c.req.param('id'));
  if (!d) return err(c, 'no_existe', 404);
  const b = await c.req.json<{ catch_all?: boolean; marca?: Partial<Marca> }>().catch(() => ({}) as { catch_all?: boolean; marca?: Partial<Marca> });
  if (typeof b.catch_all === 'boolean') await c.env.DB.prepare(`UPDATE dominios SET catch_all = ? WHERE id = ?`).bind(b.catch_all ? 1 : 0, d.id).run();
  let marca = marcaDe(d);
  if (b.marca && typeof b.marca === 'object') {
    const m = b.marca as Record<string, unknown>;
    if ('nombre' in m) marca.nombre = String(m.nombre ?? '').trim().slice(0, 80) || undefined;
    if ('sitio' in m) {
      const sitio = String(m.sitio ?? '').trim();
      if (sitio && !sitioLimpio(sitio)) return err(c, 'sitio_invalido', 400);
      marca.sitio = sitio ? sitioLimpio(sitio)! : undefined;
    }
    if ('color' in m) {
      const color = String(m.color ?? '').trim();
      if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return err(c, 'color_invalido', 400);
      marca.color = color || undefined;
    }
    await c.env.DB.prepare(`UPDATE dominios SET marca = ? WHERE id = ?`).bind(JSON.stringify(marca), d.id).run();
  }
  return c.json({ ok: true, marca });
});

/** El logo de la marca: PNG, JPG, GIF o WebP de hasta 512 KB, en R2. Se
 *  sirve público en /marca/:dominio_id/logo para que el correo lo muestre. */
const TIPOS_LOGO = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const llaveLogo = (dominio_id: string) => `marca/${dominio_id}/logo`;
rutasDominios.put('/:id/logo', async (c) => {
  const d = await dominioDe(c, c.req.param('id'));
  if (!d) return err(c, 'no_existe', 404);
  const tipo = (c.req.header('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (!TIPOS_LOGO.includes(tipo)) return err(c, 'logo_tipo_invalido', 400, { acepta: TIPOS_LOGO });
  const bytes = await c.req.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 512 * 1024) return err(c, 'logo_tamano_invalido', 400, { maximo_bytes: 512 * 1024 });
  await c.env.CORREO.put(llaveLogo(d.id), bytes, { httpMetadata: { contentType: tipo, cacheControl: 'public, max-age=86400' } });
  const marca = { ...marcaDe(d), logo: true, logo_tipo: tipo };
  await c.env.DB.prepare(`UPDATE dominios SET marca = ? WHERE id = ?`).bind(JSON.stringify(marca), d.id).run();
  return c.json({ ok: true, marca, url: `${c.env.ORIGEN}/marca/${d.id}/logo` });
});
rutasDominios.delete('/:id/logo', async (c) => {
  const d = await dominioDe(c, c.req.param('id'));
  if (!d) return err(c, 'no_existe', 404);
  await c.env.CORREO.delete(llaveLogo(d.id));
  const { logo: _l, logo_tipo: _t, ...marca } = marcaDe(d);
  await c.env.DB.prepare(`UPDATE dominios SET marca = ? WHERE id = ?`).bind(JSON.stringify(marca), d.id).run();
  return c.json({ ok: true, marca });
});

rutasDominios.delete('/:id', async (c) => {
  const d = await dominioDe(c, c.req.param('id'));
  if (!d) return err(c, 'no_existe', 404);
  const n = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM mensajes WHERE dominio_id = ?`).bind(d.id).first<{ n: number }>();
  if ((n?.n ?? 0) > 0) return err(c, 'dominio_con_correo', 409, { mensajes: n!.n });
  if (d.resend_id) { try { await borrarDominio(c.env, d.resend_id); } catch (e) { if (!(e instanceof ErrorCartero && e.estado === 404)) return erroresCartero(c, e); } }
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM direcciones WHERE dominio_id = ?`).bind(d.id),
    c.env.DB.prepare(`DELETE FROM dominios WHERE id = ?`).bind(d.id),
  ]);
  return c.json({ ok: true });
});

rutasDominios.post('/:id/direcciones', async (c) => {
  const d = await dominioDe(c, c.req.param('id'));
  if (!d) return err(c, 'no_existe', 404);
  const b = await c.req.json<{ local?: string; nombre?: string; firma?: unknown }>().catch(() => ({}) as { local?: string; nombre?: string; firma?: unknown });
  const local = String(b.local ?? '').trim().toLowerCase().replace(/@.*$/, '');
  if (!localValido(local)) return err(c, 'direccion_invalida', 400);
  const ya = await c.env.DB.prepare(`SELECT id FROM direcciones WHERE dominio_id = ? AND local = ?`).bind(d.id, local).first();
  if (ya) return err(c, 'direccion_ya_existe', 409);
  const firma = limpiarFirma(b.firma);
  // Sin nombre de salida explícito, sale con el de la firma.
  const nombre = (b.nombre ? String(b.nombre).trim().slice(0, 80) : '') || firma.nombre || null;
  const x: Direccion = { id: id(), dominio_id: d.id, local, nombre, activa: 1, creada_at: ahora(), firma: JSON.stringify(firma) };
  await c.env.DB.prepare(`INSERT INTO direcciones (id, dominio_id, local, nombre, activa, creada_at, firma) VALUES (?,?,?,?,1,?,?)`).bind(x.id, x.dominio_id, x.local, x.nombre, x.creada_at, x.firma).run();
  // Lo que ya había llegado a esa dirección sin estar dada de alta, se le asigna.
  await c.env.DB.prepare(
    `UPDATE mensajes SET direccion_id = ? WHERE dominio_id = ? AND direccion_id IS NULL AND carpeta = 'entrada'
       AND EXISTS (SELECT 1 FROM json_each(mensajes.para) WHERE lower(json_each.value) = ?)`,
  ).bind(x.id, d.id, `${local}@${d.dominio}`).run();
  return c.json({ ok: true, direccion: direccionPublica(x, d.dominio) }, 201);
});

rutasDominios.patch('/:id/direcciones/:did', async (c) => {
  const d = await dominioDe(c, c.req.param('id'));
  if (!d) return err(c, 'no_existe', 404);
  const b = await c.req.json<{ nombre?: string; activa?: boolean; firma?: unknown }>().catch(() => ({}) as { nombre?: string; activa?: boolean; firma?: unknown });
  const x = await c.env.DB.prepare(`SELECT * FROM direcciones WHERE id = ? AND dominio_id = ?`).bind(c.req.param('did'), d.id).first<Direccion>();
  if (!x) return err(c, 'no_existe', 404);
  const firma = b.firma !== undefined ? JSON.stringify(limpiarFirma(b.firma)) : x.firma;
  const nombre = b.nombre !== undefined ? String(b.nombre).trim().slice(0, 80) || null : x.nombre ?? limpiarFirma(b.firma).nombre ?? null;
  const activa = typeof b.activa === 'boolean' ? (b.activa ? 1 : 0) : x.activa;
  await c.env.DB.prepare(`UPDATE direcciones SET nombre = ?, activa = ?, firma = ? WHERE id = ?`).bind(nombre, activa, firma, x.id).run();
  return c.json({ ok: true, direccion: direccionPublica({ ...x, nombre, activa, firma }, d.dominio) });
});

/** La firma armada de una dirección (vista previa). */
rutasDominios.get('/:id/direcciones/:did/firma', async (c) => {
  const d = await dominioDe(c, c.req.param('id'));
  if (!d) return err(c, 'no_existe', 404);
  const x = await c.env.DB.prepare(`SELECT * FROM direcciones WHERE id = ? AND dominio_id = ?`).bind(c.req.param('did'), d.id).first<Direccion>();
  if (!x) return err(c, 'no_existe', 404);
  return c.json({ ok: true, ...firmaDeDireccion(c.env, x, d) });
});

/** Vista previa de una firma que aún no se guarda (el formulario en vivo). */
rutasDominios.post('/:id/firma-previa', async (c) => {
  const d = await dominioDe(c, c.req.param('id'));
  if (!d) return err(c, 'no_existe', 404);
  const b = await c.req.json<{ local?: string; firma?: unknown; marca?: Partial<Marca> }>().catch(() => ({}) as { local?: string; firma?: unknown; marca?: Partial<Marca> });
  const marca = { ...marcaDe(d), ...(b.marca && typeof b.marca === 'object' ? { nombre: String((b.marca as any).nombre ?? marcaDe(d).nombre ?? ''), sitio: sitioLimpio(String((b.marca as any).sitio ?? marcaDe(d).sitio ?? '')) ?? undefined, color: String((b.marca as any).color ?? marcaDe(d).color ?? '') } : {}) };
  return c.json({ ok: true, ...armarFirma({ local: String(b.local ?? 'correo').toLowerCase().replace(/@.*$/, '') || 'correo', dominio: d.dominio, dominio_id: d.id, marca, firma: limpiarFirma(b.firma), origen: c.env.ORIGEN }) });
});

/** ¿Hay registros que Resend no ha empezado a revisar o que fallaron? Sólo
 *  entonces vale la pena pedirle la verificación; con todo `pending` o
 *  `verified` se espera a que termine. Sin registros conocidos: sí. */
export function hayQuePedirVerificacion(registrosJson: string): boolean {
  let regs: Array<{ status?: string }> = [];
  try { regs = JSON.parse(registrosJson || '[]'); } catch { return true; }
  if (!regs.length) return true;
  return regs.some((r) => !r.status || r.status === 'not_started' || r.status === 'failed' || r.status === 'temporary_failure');
}

/** Lo que corre el cron: cada dominio pendiente se le pregunta a Resend y, si
 *  ya está verificado (o falló), se anota. Devuelve cuántos cambiaron. */
export async function refrescarPendientes(env: Env): Promise<{ revisados: number; cambiados: number }> {
  if (!env.RESEND_API_KEY) return { revisados: 0, cambiados: 0 };
  const pendientes = (await env.DB.prepare(`SELECT * FROM dominios WHERE estado = 'pendiente' AND resend_id IS NOT NULL ORDER BY creada_at LIMIT 50`).all<Dominio>()).results;
  let cambiados = 0;
  for (const d of pendientes) {
    try {
      // Pedir la verificación a Resend REINICIA su revisión y deja todo en
      // `pending` (22-oct-2026: pruebas.forespot.com llevaba 40 min sin salir
      // de ahí porque se la pedíamos cada 10). Sólo se pide si hay registros
      // que Resend no ha empezado o que fallaron; si están en curso, sólo se lee.
      if (hayQuePedirVerificacion(d.registros)) await verificarDominio(env, d.resend_id!).catch(() => undefined);
      const r = await leerDominio(env, d.resend_id!);
      const estado = estadoDe(r);
      const registros = JSON.stringify(r.records ?? []);
      if (estado !== d.estado || registros !== d.registros) {
        await env.DB.prepare(`UPDATE dominios SET estado = ?, registros = ?, verificada_at = COALESCE(verificada_at, ?) WHERE id = ?`)
          .bind(estado, registros, estado === 'verificado' ? ahora() : null, d.id).run();
        if (estado !== d.estado) cambiados++;
      }
    } catch (e) {
      console.error('refrescar', d.dominio, String(e));
      await anotar(env, { origen: 'cron', tipo: 'dominio', referencia: d.dominio, resultado: 'error', detalle: String(e) });
    }
  }
  if (pendientes.length) await anotar(env, { origen: 'cron', tipo: 'dominios', resultado: 'ok', detalle: { revisados: pendientes.length, cambiados } });
  return { revisados: pendientes.length, cambiados };
}
