#!/usr/bin/env node
/* Quita por completo un dominio de FSMAIL cuando Mike lo decide: en Resend,
 * en D1 (dominio, direcciones, mensajes, adjuntos, hilos huérfanos), en R2
 * (cuerpos, adjuntos, logo) y, si el dominio vive en una zona NUESTRA de
 * Cloudflare, sus registros DNS de Resend. La API de la app se niega a borrar
 * un dominio con correo (409) a propósito; este guion es la vía deliberada,
 * a mano, y exige escribir el dominio dos veces.
 *
 * Variables: DOMINIO y CONFIRMAR (iguales), ENTORNO (produccion | staging),
 * RESEND_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID. */

import { execFileSync } from 'node:child_process';
import { zonaDe } from './dominio-dns.mjs';

const RESEND = 'https://api.resend.com';
const CF = 'https://api.cloudflare.com/client/v4';
const dominio = (process.env.DOMINIO || '').trim().toLowerCase();
const confirmar = (process.env.CONFIRMAR || '').trim().toLowerCase();
const entorno = (process.env.ENTORNO || 'produccion').trim();
const llaveResend = process.env.RESEND_API_KEY;
const tokenCf = process.env.CLOUDFLARE_API_TOKEN;
const cuenta = process.env.CLOUDFLARE_ACCOUNT_ID;
const BASE = entorno === 'staging' ? 'fsmail-staging' : 'fsmail';
const BUCKET = entorno === 'staging' ? 'fsmail-correo-staging' : 'fsmail-correo';

async function resend(metodo, ruta) {
  const r = await fetch(RESEND + ruta, { method: metodo, headers: { Authorization: `Bearer ${llaveResend}` } });
  const t = await r.text();
  if (!r.ok) { const e = new Error(`resend ${metodo} ${ruta} → ${r.status}: ${t.slice(0, 300)}`); e.estado = r.status; throw e; }
  return t ? JSON.parse(t) : {};
}
async function cf(metodo, ruta, cuerpo) {
  const r = await fetch(CF + ruta, { method: metodo, headers: { Authorization: `Bearer ${tokenCf}`, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`cloudflare ${metodo} ${ruta} → ${r.status}: ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
  return j.result;
}
async function d1(baseId, sql, params = []) {
  const res = await cf('POST', `/accounts/${cuenta}/d1/database/${baseId}/query`, { sql, params });
  return res[0]?.results ?? [];
}

/** Los registros DNS que Resend pidió para este dominio y nada más: el MX de
 *  recepción y el SPF en el dominio mismo, y todo lo que cuelga de
 *  send.<dominio> y resend._domainkey.<dominio>. DMARC y lo ajeno se quedan. */
export function registrosDeResend(existentes, dominio) {
  const limpio = (c) => String(c ?? '').replace(/^"|"$/g, '').trim().toLowerCase();
  const deResend = (c) => /rmta\.net|amazonses\.com|resend\.com/.test(limpio(c));
  return existentes.filter((e) => {
    const n = String(e.name).toLowerCase();
    if (n === `send.${dominio}` || n === `resend._domainkey.${dominio}`) return true;
    if (n !== dominio) return false;
    if (e.type === 'MX') return deResend(e.content);
    if (e.type === 'TXT') return /^v=spf1/.test(limpio(e.content)) && deResend(e.content);
    return false;
  });
}

async function main() {
  if (!dominio) throw new Error('falta DOMINIO');
  if (confirmar !== dominio) throw new Error(`CONFIRMAR («${confirmar}») no es igual a DOMINIO («${dominio}»): no se toca nada`);
  if (!llaveResend || !tokenCf || !cuenta) throw new Error('faltan RESEND_API_KEY, CLOUDFLARE_API_TOKEN y/o CLOUDFLARE_ACCOUNT_ID');

  // 1. El dominio en D1.
  const bases = await cf('GET', `/accounts/${cuenta}/d1/database?name=${BASE}`);
  const base = bases.find((b) => b.name === BASE);
  if (!base) throw new Error(`no existe la base ${BASE}`);
  const [d] = await d1(base.uuid, `SELECT id, cuenta_id, resend_id, estado FROM dominios WHERE dominio = ?`, [dominio]);
  if (!d) throw new Error(`${dominio} no está en FSMAIL (${entorno})`);
  const mensajes = await d1(base.uuid, `SELECT id, r2_llave FROM mensajes WHERE dominio_id = ?`, [d.id]);
  const adjuntos = await d1(base.uuid, `SELECT a.r2_llave FROM adjuntos a JOIN mensajes m ON m.id = a.mensaje_id WHERE m.dominio_id = ?`, [d.id]);
  const [{ n: direcciones }] = await d1(base.uuid, `SELECT COUNT(*) AS n FROM direcciones WHERE dominio_id = ?`, [d.id]);
  console.log(`dominio ${dominio} (${entorno}): id=${d.id} estado=${d.estado} direcciones=${direcciones} mensajes=${mensajes.length} adjuntos=${adjuntos.length}`);

  // 2. Resend.
  let resendId = d.resend_id;
  if (!resendId) { const lista = await resend('GET', '/domains'); resendId = (lista.data ?? lista).find?.((x) => x.name === dominio)?.id ?? null; }
  if (resendId) {
    try { await resend('DELETE', `/domains/${resendId}`); console.log(`  Resend: borrado ${resendId}`); }
    catch (e) { if (e.estado !== 404) throw e; console.log(`  Resend: ya no estaba (${resendId})`); }
  } else console.log('  Resend: no estaba dado de alta');

  // 3. DNS, sólo si el dominio vive en una zona de esta cuenta.
  const zonas = await cf('GET', `/zones?per_page=50`);
  const zona = zonaDe(dominio, zonas);
  let dnsBorrados = 0;
  if (zona) {
    const existentes = await cf('GET', `/zones/${zona.id}/dns_records?per_page=500`);
    for (const r of registrosDeResend(existentes, dominio)) {
      await cf('DELETE', `/zones/${zona.id}/dns_records/${r.id}`);
      console.log(`  DNS: borrado ${r.type} ${r.name}`);
      dnsBorrados++;
    }
  } else console.log('  DNS: zona ajena, no se toca');

  // 4. R2: cuerpos, adjuntos y logo.
  const llaves = [...mensajes.map((m) => m.r2_llave), ...adjuntos.map((a) => a.r2_llave), `marca/${d.id}/logo`];
  let r2Borrados = 0;
  for (const llave of llaves) {
    try {
      execFileSync('npx', ['wrangler', 'r2', 'object', 'delete', `${BUCKET}/${llave}`, '--remote'], { stdio: 'pipe', env: process.env });
      r2Borrados++;
    } catch (e) {
      const salida = String(e.stdout || '') + String(e.stderr || '');
      if (!/not found|does not exist|10007/i.test(salida)) throw new Error(`R2 ${llave}: ${salida.slice(-300)}`);
    }
  }
  console.log(`  R2: ${r2Borrados} objetos borrados de ${llaves.length}`);

  // 5. D1, al final, para que un tropiezo arriba deje rastro de qué quedó.
  await d1(base.uuid, `DELETE FROM adjuntos WHERE mensaje_id IN (SELECT id FROM mensajes WHERE dominio_id = ?)`, [d.id]);
  await d1(base.uuid, `DELETE FROM mensajes WHERE dominio_id = ?`, [d.id]);
  await d1(base.uuid, `DELETE FROM hilos WHERE cuenta_id = ? AND id NOT IN (SELECT hilo_id FROM mensajes)`, [d.cuenta_id]);
  await d1(base.uuid, `DELETE FROM direcciones WHERE dominio_id = ?`, [d.id]);
  await d1(base.uuid, `DELETE FROM dominios WHERE id = ?`, [d.id]);
  const [{ n: quedan }] = await d1(base.uuid, `SELECT COUNT(*) AS n FROM dominios WHERE dominio = ?`, [dominio]);
  console.log(`quitado ${dominio}: Resend ${resendId ? 'sí' : 'n/a'}, DNS ${dnsBorrados}, R2 ${r2Borrados}, D1 ${direcciones} direcciones y ${mensajes.length} mensajes; quedan=${quedan}`);
  if (quedan !== 0) throw new Error('el dominio sigue en D1');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.log(`::error::quitar-dominio: ${e.message}`); process.exit(1); });
}
