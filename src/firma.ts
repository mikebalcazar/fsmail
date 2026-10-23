/* La firma de una dirección: un banner en HTML (tabla con estilos en línea,
 * que es lo que Gmail y Outlook respetan) y su versión en texto. El logo
 * liga al sitio del producto, el nombre a `mailto:` de la dirección, el
 * teléfono a WhatsApp y el sitio a sí mismo. */

import type { Direccion, Dominio } from './entorno';
import { esc } from './lib';

export interface Marca { nombre?: string; sitio?: string; color?: string; logo?: boolean; logo_tipo?: string }
export interface Firma { nombre?: string; puesto?: string; telefono?: string; extra?: string }

export const marcaDe = (d: Pick<Dominio, 'marca'>): Marca => { try { return JSON.parse(d.marca || '{}'); } catch { return {}; } };
export const firmaDe = (x: Pick<Direccion, 'firma'>): Firma => { try { return JSON.parse(x.firma || '{}'); } catch { return {}; } };

/** Sólo dígitos; 10 dígitos se toman como México (+52). Null si no sirve. */
export function telefonoWhatsapp(telefono: string | undefined): string | null {
  const d = String(telefono ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) return `52${d}`;
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}

export function sitioLimpio(sitio: string | undefined): string | null {
  const s = String(sitio ?? '').trim();
  if (!s) return null;
  const con = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try { const u = new URL(con); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().replace(/\/$/, '') : null; } catch { return null; }
}

const colorLimpio = (c: string | undefined) => (/^#[0-9a-f]{6}$/i.test(String(c ?? '')) ? String(c) : '#1f2937');

/** El banner. `origen` es la dirección pública de FSMAIL, para la liga del logo. */
export function armarFirma(p: { local: string; dominio: string; dominio_id: string; marca: Marca; firma: Firma; origen: string }): { html: string; texto: string; hay: boolean } {
  const f = p.firma;
  const hay = !!(f.nombre || f.puesto || f.telefono);
  if (!hay) return { html: '', texto: '', hay: false };
  const correo = `${p.local}@${p.dominio}`;
  const sitio = sitioLimpio(p.marca.sitio);
  const sitioTexto = sitio ? sitio.replace(/^https?:\/\//, '') : null;
  const wa = telefonoWhatsapp(f.telefono);
  const color = colorLimpio(p.marca.color);
  const logo = p.marca.logo ? `${p.origen.replace(/\/$/, '')}/marca/${p.dominio_id}/logo` : null;
  const marcaNombre = p.marca.nombre || p.dominio;
  const liga = (href: string, texto: string, estilo = '') => `<a href="${esc(href)}" style="color:${color};text-decoration:none;${estilo}" target="_blank" rel="noopener">${texto}</a>`;

  const logoHtml = logo
    ? `<td style="padding:0 16px 0 0;vertical-align:middle;border-right:2px solid ${color}">${sitio ? liga(sitio, `<img src="${esc(logo)}" alt="${esc(marcaNombre)}" width="96" style="display:block;max-width:96px;height:auto;border:0">`) : `<img src="${esc(logo)}" alt="${esc(marcaNombre)}" width="96" style="display:block;max-width:96px;height:auto;border:0">`}</td>`
    : '';
  const renglones: string[] = [];
  if (f.nombre) renglones.push(`<div style="font-size:16px;font-weight:700;color:#111827">${liga(`mailto:${correo}`, esc(f.nombre), 'color:#111827')}</div>`);
  if (f.puesto) renglones.push(`<div style="font-size:13px;color:#4b5563">${esc(f.puesto)}${marcaNombre ? ` · <span style="color:${color};font-weight:600">${esc(marcaNombre)}</span>` : ''}</div>`);
  else if (marcaNombre) renglones.push(`<div style="font-size:13px;color:${color};font-weight:600">${esc(marcaNombre)}</div>`);
  const contacto: string[] = [];
  if (f.telefono) contacto.push(wa ? liga(`https://wa.me/${wa}`, `📱 ${esc(f.telefono)}`) : `📱 ${esc(f.telefono)}`);
  contacto.push(liga(`mailto:${correo}`, `✉ ${esc(correo)}`));
  if (sitio && sitioTexto) contacto.push(liga(sitio, `🌐 ${esc(sitioTexto)}`));
  renglones.push(`<div style="font-size:13px;margin-top:6px;line-height:1.7">${contacto.join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</div>`);
  if (f.extra) renglones.push(`<div style="font-size:12px;color:#6b7280;margin-top:6px">${esc(f.extra)}</div>`);

  const html = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-family:Helvetica,Arial,sans-serif;color:#111827;margin-top:18px"><tr>${logoHtml}<td style="padding:0 0 0 ${logo ? 16 : 0}px;vertical-align:middle">${renglones.join('')}</td></tr></table>`;
  const texto = ['--', f.nombre, [f.puesto, marcaNombre].filter(Boolean).join(' · '), f.telefono ? `Tel/WhatsApp: ${f.telefono}${wa ? ` (https://wa.me/${wa})` : ''}` : null, correo, sitio].filter(Boolean).join('\n');
  return { html, texto, hay: true };
}

/** Texto plano → HTML con párrafos, para pegarle la firma debajo. */
export function textoAHtml(texto: string): string {
  const parrafos = texto.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, '<br>')}</p>`);
  return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111827">${parrafos.join('')}</div>`;
}
