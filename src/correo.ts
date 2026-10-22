/* Los correos PROPIOS de FSMAIL (hoy: el código de acceso). Salen por el
 * cartero con el remitente CORREO_REMITENTE. Fuera de producción no salen:
 * el código viaja en la respuesta y las pruebas lo leen de ahí. Mandar a
 * direcciones inventadas sólo produce rebotes a nombre del dominio. */

import type { Env } from './entorno';
import { enviar } from './cartero';
import { esc } from './lib';

const sale = (env: Env) => env.ENTORNO === 'produccion' || env.CORREO_DE_VERDAD === '1';
export const devuelveCodigo = (env: Env) => env.ENTORNO !== 'produccion';

export const NO_SE_CONTESTA = 'Este buzón no recibe respuestas.';

export function plantillaCodigo(codigo: string, username: string): { asunto: string; texto: string; html: string } {
  return {
    asunto: `Tu código de acceso a FSMAIL: ${codigo}`,
    texto: `Hola ${username}. Tu código de acceso es ${codigo}. Vence en 10 minutos. Si tú no lo pediste, ignora este correo.\n\n${NO_SE_CONTESTA}`,
    html: `<!doctype html><html lang="es"><body style="margin:0;background:#0f1115;font-family:Inter,Helvetica,Arial,sans-serif;color:#e8eaed">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#171a21;border-radius:14px;overflow:hidden">
<tr><td style="padding:22px 26px;border-bottom:1px solid #262a33"><span style="font-size:18px;font-weight:700;letter-spacing:2px;color:#fff">FSMAIL</span></td></tr>
<tr><td style="padding:26px">
<p style="margin:0 0 8px;font-size:15px">Hola <b>${esc(username)}</b>.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.6">Tu código de acceso. Vence en 10 minutos.</p>
<div style="font-size:34px;font-weight:700;letter-spacing:10px;color:#fff;background:#0f1115;border-radius:10px;padding:16px;text-align:center;font-variant-numeric:tabular-nums">${codigo}</div>
<p style="margin:18px 0 0;font-size:13px;color:#9aa3ad">Si tú no lo pediste, ignora este correo.</p>
</td></tr>
<tr><td style="padding:14px 26px 22px;border-top:1px solid #262a33;font-size:12px;color:#9aa3ad">${NO_SE_CONTESTA}</td></tr>
</table></td></tr></table></body></html>`,
  };
}

export async function mandarCodigo(env: Env, para: string, codigo: string, username: string): Promise<{ enviado: boolean; motivo?: string }> {
  if (!sale(env)) return { enviado: false, motivo: 'correo_apagado_fuera_de_produccion' };
  if (!env.RESEND_API_KEY) return { enviado: false, motivo: 'correo_no_configurado' };
  const p = plantillaCodigo(codigo, username);
  try {
    await enviar(env, { from: env.CORREO_REMITENTE, to: [para], subject: p.asunto, text: p.texto, html: p.html, headers: { 'X-Entity-Ref-ID': crypto.randomUUID() } });
    return { enviado: true };
  } catch (e) {
    console.error('codigo no salio', String(e));
    return { enviado: false, motivo: 'correo_no_salio' };
  }
}
