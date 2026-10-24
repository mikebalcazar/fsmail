import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { E, cuentaNueva, direccion, dominioVerificado, json, recibido, webhook, fetchDeMentira, sinPendientes, esperaResend, esperaUrl, type Capturada } from './ayuda';
import { b64u, cifrarPush, deB64u } from '../src/push';

beforeAll(fetchDeMentira);
afterEach(sinPendientes);

const te = (s: string) => new TextEncoder().encode(s);
const concat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}
/** Un «navegador» de mentira: su par ECDH y su secreto `auth`, y cómo descifra (RFC 8291 del lado del receptor). */
async function navegadorDeMentira() {
  const par = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const uaPub = new Uint8Array((await crypto.subtle.exportKey('raw', par.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys: { p256dh: b64u(uaPub), auth: b64u(auth) },
    async descifrar(cuerpo: Uint8Array): Promise<string> {
      const salt = cuerpo.slice(0, 16); const rs = new DataView(cuerpo.buffer, cuerpo.byteOffset + 16, 4).getUint32(0); const idlen = cuerpo[20];
      expect(rs).toBe(4096); expect(idlen).toBe(65);
      const asPub = cuerpo.slice(21, 21 + idlen); const cifrado = cuerpo.slice(21 + idlen);
      const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey } as unknown as Parameters<SubtleCrypto['deriveBits']>[0], par.privateKey, 256));
      const ikm = await hkdf(auth, ecdh, concat(te('WebPush: info\0'), uaPub, asPub), 32);
      const cek = await hkdf(salt, ikm, te('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, te('Content-Encoding: nonce\0'), 12);
      const llave = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plano = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, llave, cifrado));
      expect(plano[plano.length - 1]).toBe(2); // delimitador del último registro
      return new TextDecoder().decode(plano.slice(0, -1));
    },
  };
}

describe('web push: cifrado', () => {
  it('lo que cifra el Worker lo descifra el navegador (RFC 8291, aes128gcm)', async () => {
    const nav = await navegadorDeMentira();
    const texto = te('hola, correo nuevo ✉️');
    const cuerpo = await cifrarPush(nav.keys, texto);
    expect(cuerpo.length).toBe(16 + 4 + 1 + 65 + texto.length + 1 + 16); // cabecera + texto + 0x02 + etiqueta GCM
    expect(await nav.descifrar(cuerpo)).toBe('hola, correo nuevo ✉️');
  });
  it('rechaza suscripciones con llaves de otro tamaño', async () => {
    await expect(cifrarPush({ p256dh: b64u(new Uint8Array(33)), auth: b64u(new Uint8Array(16)) }, te('x'))).rejects.toThrow(/inválidas/);
  });
});

describe('web push: rutas y avisos', () => {
  it('la clave pública es P-256 sin comprimir y es la misma siempre', async () => {
    const { cookie } = await cuentaNueva('u-p1');
    const a = await json('/api/push/clave', undefined, { cookie }); const b = await json('/api/push/clave', undefined, { cookie });
    expect(a.ok).toBe(true); expect(deB64u(a.publica).length).toBe(65); expect(deB64u(a.publica)[0]).toBe(4); expect(b.publica).toBe(a.publica);
  });
  it('suscribir valida, es idempotente por endpoint y se puede dar de baja', async () => {
    const { cookie } = await cuentaNueva('u-p2');
    const nav = await navegadorDeMentira();
    expect((await json('/api/push/suscribir', { endpoint: 'http://inseguro', keys: nav.keys }, { cookie })).error).toBe('suscripcion_invalida');
    expect((await json('/api/push/suscribir', { endpoint: 'https://push.example/x', keys: { p256dh: 'abc', auth: 'def' } }, { cookie })).error).toBe('suscripcion_invalida');
    const r = await json('/api/push/suscribir', { endpoint: 'https://push.example/s/1', keys: nav.keys, agente: 'Chrome Mac' }, { cookie });
    expect(r.estado).toBe(201); expect(r.suscripciones).toBe(1);
    expect((await json('/api/push/suscribir', { endpoint: 'https://push.example/s/1', keys: nav.keys, agente: 'Chrome Mac' }, { cookie })).suscripciones).toBe(1);
    const est = await json('/api/push/estado', undefined, { cookie });
    expect(est.suscripciones).toHaveLength(1); expect(est.suscripciones[0].agente).toBe('Chrome Mac');
    expect((await json('/api/push/suscribir', { endpoint: 'https://push.example/s/1' }, { cookie, metodo: 'DELETE' })).borradas).toBe(1);
    expect((await json('/api/push/estado', undefined, { cookie })).suscripciones).toHaveLength(0);
    expect((await json('/api/push/probar', {}, { cookie })).error).toBe('sin_suscripciones');
  });
  it('un correo que entra manda un aviso cifrado y firmado (VAPID) a cada navegador de la cuenta; 410 borra la suscripción', async () => {
    const { cookie } = await cuentaNueva('u-p3');
    const d = await dominioVerificado(cookie, 'avisa.mx'); await direccion(cookie, d.id, 'hola');
    const nav1 = await navegadorDeMentira(), nav2 = await navegadorDeMentira();
    await json('/api/push/suscribir', { endpoint: 'https://fcm.example/p/uno', keys: nav1.keys, agente: 'Chrome' }, { cookie });
    await json('/api/push/suscribir', { endpoint: 'https://apple.example/p/dos', keys: nav2.keys, agente: 'Safari' }, { cookie });
    const clave = (await json('/api/push/clave', undefined, { cookie })).publica;
    let pedido: Capturada | undefined;
    esperaUrl('POST', 'https://fcm.example/p/uno', '', {}, 201, (req) => { pedido = req; });
    esperaUrl('POST', 'https://apple.example/p/dos', 'gone', {}, 410);
    esperaResend('GET', '/emails/receiving/em_push', recibido({ id: 'em_push', de: 'Cliente <cliente@gmail.com>', para: ['hola@avisa.mx'], asunto: 'Pedido urgente', texto: 'Necesito 50 piezas.' }));
    const w = await webhook({ type: 'email.received', data: { email_id: 'em_push' } });
    expect(w.estado).toBe(200); expect(w.push).toEqual({ enviadas: 1, fallidas: 0, borradas: 1 });
    expect(pedido).toBeDefined();
    const h = pedido!.headers;
    expect(h['content-encoding']).toBe('aes128gcm'); expect(h['ttl']).toBe('86400'); expect(h['content-type']).toBe('application/octet-stream');
    const auth = h['authorization']; const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth)!;
    expect(m).not.toBeNull(); expect(m[2]).toBe(clave);
    // El JWT: audiencia = origen del endpoint, firmado con la clave pública que anunciamos.
    const [cab, carga, firma] = m[1].split('.');
    const jwt = JSON.parse(new TextDecoder().decode(deB64u(carga)));
    expect(JSON.parse(new TextDecoder().decode(deB64u(cab)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(jwt.aud).toBe('https://fcm.example'); expect(jwt.sub).toBe('mailto:acceso@mailing.forespot.com'); expect(jwt.exp).toBeGreaterThan(Date.now() / 1000 + 3600);
    const pub = await crypto.subtle.importKey('raw', deB64u(clave), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, deB64u(firma), te(`${cab}.${carga}`))).toBe(true);
    // El cuerpo: lo descifra sólo ese navegador y trae el correo.
    const aviso = JSON.parse(await nav1.descifrar(pedido!.bytes));
    const msg = (await json('/api/mensajes', undefined, { cookie })).mensajes[0];
    expect(aviso).toMatchObject({ titulo: 'Cliente', id: msg.id, etiqueta: 'hola@avisa.mx', url: `https://fsmail.test/#m=${msg.id}` });
    expect(aviso.cuerpo).toContain('Pedido urgente'); expect(aviso.cuerpo).toContain('Necesito 50 piezas.');
    // La de Safari contestó 410: ya no está.
    const est = await json('/api/push/estado', undefined, { cookie });
    expect(est.suscripciones.map((s: any) => s.agente)).toEqual(['Chrome']); expect(est.suscripciones[0].ultimo_envio).toBeTruthy();
  });
  it('sin suscripciones el webhook no sale a ningún lado', async () => {
    const { cookie } = await cuentaNueva('u-p4');
    const d = await dominioVerificado(cookie, 'callado.mx'); await direccion(cookie, d.id, 'a');
    esperaResend('GET', '/emails/receiving/em_cal', recibido({ id: 'em_cal', para: ['a@callado.mx'] }));
    const w = await webhook({ type: 'email.received', data: { email_id: 'em_cal' } });
    expect(w.push).toEqual({ enviadas: 0, fallidas: 0, borradas: 0 });
    void E;
  });
});
