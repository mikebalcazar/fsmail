#!/usr/bin/env node
/* El dominio desde el que FSMAIL manda sus propios correos (decisión de Mike,
 * 22-oct-2026: acceso@mailing.forespot.com).
 *
 * Corre en el runner de Actions, después de publicar. Es idempotente:
 *  1. Si mailing.forespot.com no está en Resend, lo da de alta SÓLO para envío
 *     (la recepción de los negocios va por sus propios dominios).
 *  2. Pone en la zona forespot.com de Cloudflare los registros que Resend pide
 *     (DKIM TXT, MX y TXT del retorno `send.`), DNS only, creando o
 *     corrigiendo lo que haga falta y sin tocar nada más.
 *  3. Pide la verificación y reporta el estado.
 *
 * Variables: RESEND_API_KEY, CLOUDFLARE_API_TOKEN (Zone DNS Edit en
 * forespot.com). Opcional: DOMINIO_REMITENTE (por omisión mailing.forespot.com). */

const RESEND = 'https://api.resend.com';
const CF = 'https://api.cloudflare.com/client/v4';
const dominio = process.env.DOMINIO_REMITENTE || 'mailing.forespot.com';
const zona = dominio.split('.').slice(-2).join('.');
const llaveResend = process.env.RESEND_API_KEY;
const tokenCf = process.env.CLOUDFLARE_API_TOKEN;

async function resend(metodo, ruta, cuerpo) {
  const r = await fetch(RESEND + ruta, { method: metodo, headers: { Authorization: `Bearer ${llaveResend}`, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
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

/** El nombre tal como lo quiere Cloudflare (FQDN) a partir de lo que dice Resend
 *  (que a veces es relativo al dominio, a veces absoluto). */
export function nombreCompleto(nombre, dominio) {
  const n = String(nombre).replace(/\.$/, '');
  if (n === '@' || n === '') return dominio;
  if (n === dominio || n.endsWith('.' + dominio)) return n;
  return `${n}.${dominio}`;
}

/** Qué hay que crear o corregir: compara lo que pide Resend con lo que hay. */
export function plan(registros, existentes, dominio) {
  const acciones = [];
  for (const r of registros) {
    const tipo = String(r.type).toUpperCase();
    if (!['TXT', 'MX', 'CNAME'].includes(tipo)) continue;
    const name = nombreCompleto(r.name, dominio);
    const deseado = { type: tipo, name, content: tipo === 'TXT' ? String(r.value) : String(r.value).replace(/\.$/, ''), ttl: 1, proxied: false, ...(tipo === 'MX' ? { priority: Number(r.priority ?? 10) } : {}) };
    const mismos = existentes.filter((e) => e.type === tipo && e.name === name);
    const igual = mismos.find((e) => limpio(e.content) === limpio(deseado.content) && (tipo !== 'MX' || Number(e.priority) === deseado.priority));
    if (igual) { acciones.push({ accion: 'igual', deseado }); continue; }
    // Un TXT puede convivir con otros (varios TXT en el mismo nombre); MX y
    // CNAME de Resend en un nombre que es sólo suyo (send., resend._domainkey)
    // se corrigen en lugar de duplicarse.
    const corregible = tipo !== 'TXT' ? mismos[0] : mismos.find((e) => /^v=spf1/i.test(limpio(e.content)) && /^v=spf1/i.test(deseado.content));
    acciones.push(corregible ? { accion: 'corregir', id: corregible.id, deseado } : { accion: 'crear', deseado });
  }
  return acciones;
}
const limpio = (c) => String(c).replace(/^"|"$/g, '').trim();

async function main() {
  if (!llaveResend || !tokenCf) {
    console.log(`::warning::remitente: faltan ${[!llaveResend && 'RESEND_API_KEY', !tokenCf && 'CLOUDFLARE_API_TOKEN'].filter(Boolean).join(' y ')}; no se toca nada.`);
    return;
  }
  // 1. El dominio en Resend.
  const lista = await resend('GET', '/domains');
  let dom = (lista.data ?? lista).find?.((d) => d.name === dominio) ?? null;
  if (!dom) {
    console.log(`remitente: ${dominio} no está en Resend; se da de alta (sólo envío)`);
    dom = await resend('POST', '/domains', { name: dominio, capabilities: { sending: 'enabled', receiving: 'disabled' } });
  }
  dom = await resend('GET', `/domains/${dom.id}`);
  console.log(`remitente: Resend ${dominio} id=${dom.id} estado=${dom.status} registros=${(dom.records ?? []).length}`);

  // 2. Los registros en Cloudflare.
  const zonas = await cf('GET', `/zones?name=${zona}`);
  if (!zonas?.length) throw new Error(`la zona ${zona} no está en esta cuenta de Cloudflare (o el token no la alcanza)`);
  const zonaId = zonas[0].id;
  const existentes = await cf('GET', `/zones/${zonaId}/dns_records?per_page=500`);
  const acciones = plan(dom.records ?? [], existentes, dominio);
  for (const a of acciones) {
    const d = a.deseado;
    if (a.accion === 'crear') { await cf('POST', `/zones/${zonaId}/dns_records`, d); console.log(`  creado   ${d.type} ${d.name} → ${d.content}${d.priority ? ' (' + d.priority + ')' : ''}`); }
    else if (a.accion === 'corregir') { await cf('PATCH', `/zones/${zonaId}/dns_records/${a.id}`, d); console.log(`  corregido ${d.type} ${d.name} → ${d.content}`); }
    else console.log(`  igual    ${d.type} ${d.name}`);
  }

  // 3. Verificar.
  if (dom.status !== 'verified') {
    await resend('POST', `/domains/${dom.id}/verify`).catch((e) => console.log(`  (verify: ${e.message})`));
    dom = await resend('GET', `/domains/${dom.id}`);
  }
  const resumen = `remitente ${dominio}: Resend=${dom.status} · DNS ${acciones.filter((a) => a.accion === 'crear').length} creados, ${acciones.filter((a) => a.accion === 'corregir').length} corregidos, ${acciones.filter((a) => a.accion === 'igual').length} iguales`;
  console.log(resumen);
  if (process.env.GITHUB_OUTPUT) await import('node:fs').then((fs) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `resumen=${resumen}\n`));
  if (dom.status !== 'verified') console.log('::warning::el dominio remitente todavía no está verificado en Resend; el DNS recién puesto tarda minutos. El siguiente run lo vuelve a revisar.');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.log(`::error::remitente: ${e.message}`); process.exit(1); });
}
