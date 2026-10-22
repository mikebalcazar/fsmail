/* Utilería compartida: ids, hashes, cookies, validaciones, fechas. */

export const ahora = () => new Date().toISOString();
export const enSegundos = (s: number) => new Date(Date.now() + s * 1000).toISOString();
export const vencida = (iso: string) => Date.parse(iso) <= Date.now();

export const id = () => crypto.randomUUID();

export async function sha256(texto: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparación en tiempo constante (cadenas del mismo largo). */
export function igualSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function tokenAleatorio(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export const COOKIE = 'fsm';
export function cookie(valor: string, vidaSegundos: number): string {
  return `${COOKIE}=${valor}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${vidaSegundos}`;
}
export function leerCookie(cabecera: string | undefined, nombre = COOKIE): string | null {
  if (!cabecera) return null;
  for (const parte of cabecera.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nombre) return v.join('=');
  }
  return null;
}

export const correoValido = (c: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c) && c.length <= 254;
export const usernameValido = (u: string) => /^[a-z0-9][a-z0-9._-]{2,31}$/.test(u);
export const localValido = (l: string) => /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(l);

/** negocio.com → 'negocio.com'; quita protocolo, ruta, www., mayúsculas. Null si no parece dominio. */
export function dominioLimpio(entrada: unknown): string | null {
  let d = String(entrada ?? '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].replace(/\.$/, '');
  if (d.startsWith('www.')) d = d.slice(4);
  if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return null;
  return d;
}

/** 'Juan Pérez <juan@x.com>' → { nombre:'Juan Pérez', correo:'juan@x.com' } */
export function partirRemitente(texto: string): { nombre: string | null; correo: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(texto);
  if (m) return { nombre: m[1].trim() || null, correo: m[2].trim().toLowerCase() };
  return { nombre: null, correo: texto.trim().toLowerCase() };
}

export function resumenDe(texto: string | null | undefined, html?: string | null): string {
  let t = texto ?? '';
  if (!t && html) t = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  return t.replace(/\s+/g, ' ').trim().slice(0, 160);
}

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
