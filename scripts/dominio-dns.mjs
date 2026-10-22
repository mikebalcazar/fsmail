#!/usr/bin/env node
/* Pone en la zona de Cloudflare los registros que Resend pide para un dominio
 * de FSMAIL que vive en una zona NUESTRA (hoy: pruebas.forespot.com, la
 * primera prueba real, decisión de Mike 22-oct-2026). Un negocio normal los
 * pone en su propio DNS: esto es sólo para los dominios de Forespot.
 *
 * Idempotente. Reusa el plan de scripts/remitente.mjs. Variables:
 * DOMINIO (obligatoria), RESEND_API_KEY, CLOUDFLARE_API_TOKEN. */

import { nombreCompleto, plan } from './remitente.mjs';

const RESEND = 'https://api.resend.com';
const CF = 'https://api.cloudflare.com/client/v4';
const dominio = (process.env.DOMINIO || '').trim().toLowerCase();
const llaveResend = process.env.RESEND_API_KEY;
const tokenCf = process.env.CLOUDFLARE_API_TOKEN;

async function resend(metodo, ruta) {
  const r = await fetch(RESEND + ruta, { method: metodo, headers: { Authorization: `Bearer ${llaveResend}` } });
  const t = await r.text();
  if (!r.ok) throw new Error(`resend ${metodo} ${ruta} → ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}
async function cf(metodo, ruta, cuerpo) {
  const r = await fetch(CF + ruta, { method: metodo, headers: { Authorization: `Bearer ${tokenCf}`, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`cloudflare ${metodo} ${ruta} → ${r.status}: ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
  return j.result;
}

/** La zona de Cloudflare que contiene al dominio: la más larga que sea sufijo. */
export function zonaDe(dominio, zonas) {
  return zonas.filter((z) => dominio === z.name || dominio.endsWith('.' + z.name)).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

async function main() {
  if (!dominio) throw new Error('falta DOMINIO');
  if (!llaveResend || !tokenCf) throw new Error('faltan RESEND_API_KEY y/o CLOUDFLARE_API_TOKEN');
  const lista = await resend('GET', '/domains');
  const breve = (lista.data ?? lista).find?.((d) => d.name === dominio);
  if (!breve) throw new Error(`${dominio} no está dado de alta en Resend: primero se agrega en FSMAIL`);
  const dom = await resend('GET', `/domains/${breve.id}`);
  console.log(`dominio ${dominio}: Resend id=${dom.id} estado=${dom.status} registros=${(dom.records ?? []).length}`);
  const zonas = await cf('GET', `/zones?per_page=50`);
  const zona = zonaDe(dominio, zonas);
  if (!zona) throw new Error(`ninguna zona de esta cuenta contiene a ${dominio}`);
  const existentes = await cf('GET', `/zones/${zona.id}/dns_records?per_page=500`);
  const acciones = plan(dom.records ?? [], existentes, zona.name);
  for (const a of acciones) {
    const d = a.deseado;
    if (a.accion === 'crear') { await cf('POST', `/zones/${zona.id}/dns_records`, d); console.log(`  creado    ${d.type} ${d.name} → ${d.content}${d.priority ? ' (' + d.priority + ')' : ''}`); }
    else if (a.accion === 'corregir') { await cf('PATCH', `/zones/${zona.id}/dns_records/${a.id}`, d); console.log(`  corregido ${d.type} ${d.name} → ${d.content}`); }
    else console.log(`  igual     ${d.type} ${d.name}`);
  }
  const resumen = `dominio ${dominio} en zona ${zona.name}: ${acciones.filter((a) => a.accion === 'crear').length} creados, ${acciones.filter((a) => a.accion === 'corregir').length} corregidos, ${acciones.filter((a) => a.accion === 'igual').length} iguales; Resend=${dom.status}`;
  console.log(resumen);
  void nombreCompleto;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.log(`::error::dominio-dns: ${e.message}`); process.exit(1); });
}
