import { beforeAll, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { BASE, json, cuentaNueva, fetchDeMentira, sinPendientes, esperaResend, esperaUrl } from './ayuda';

beforeAll(() => fetchDeMentira());

describe('salud e interfaz', () => {
  it('/salud dice quién es', async () => {
    const r = await json('/salud');
    expect(r.estado).toBe(200); expect(r.app).toBe('fsmail'); expect(r.entorno).toBe('prueba');
  });
  it('/ sirve la interfaz con sus tres pasos de entrada', async () => {
    const r = await json('/');
    expect(r.estado).toBe(200);
    for (const id of ['paso-usuario', 'paso-registro', 'paso-codigo', 'arbol', 'lista', 'lector']) expect(r.texto).toContain(`id="${id}"`);
  });
});

describe('fuera de buscadores', () => {
  it('/robots.txt cierra todo y cada respuesta lleva X-Robots-Tag noindex', async () => {
    const r = await SELF.fetch(BASE + '/robots.txt');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('User-agent: *\nDisallow: /\n');
    for (const ruta of ['/robots.txt', '/', '/mensajes/', '/salud', '/api/yo', '/api/no-existe']) {
      const x = await SELF.fetch(BASE + ruta);
      expect(x.headers.get('X-Robots-Tag'), ruta).toBe('noindex, nofollow');
      await x.arrayBuffer();
    }
  });
});

describe('registro y entrada', () => {
  it('rechaza username y correo inválidos', async () => {
    expect((await json('/api/auth/registro', { username: 'Mi Ke', correo: 'a@b.mx' })).error).toBe('username_invalido');
    expect((await json('/api/auth/registro', { username: 'mike2', correo: 'no-es-correo' })).error).toBe('correo_invalido');
  });
  it('crea la cuenta, manda código (en prueba viaja en la respuesta) y entra', async () => {
    const { cookie, cuenta } = await cuentaNueva('ana');
    expect(cuenta.username).toBe('ana');
    const yo = await json('/api/yo', undefined, { cookie });
    expect(yo.estado).toBe(200); expect(yo.cuenta.correo).toBe('ana@ejemplo.mx');
  });
  it('username y correo repetidos → 409', async () => {
    await cuentaNueva('beto');
    expect((await json('/api/auth/registro', { username: 'beto', correo: 'otro@ejemplo.mx' })).error).toBe('username_ocupado');
    expect((await json('/api/auth/registro', { username: 'beto2', correo: 'beto@ejemplo.mx' })).error).toBe('correo_ocupado');
  });
  it('código equivocado → 401 y cuenta intentos; el bueno entra con usuario O correo', async () => {
    const reg = await json('/api/auth/registro', { username: 'caro', correo: 'caro@ejemplo.mx' });
    const malo = await json('/api/auth/entrar', { usuario: 'caro', codigo: reg.codigo_prueba === '000000' ? '111111' : '000000' });
    expect(malo.estado).toBe(401); expect(malo.intentos_restantes).toBe(4);
    const bueno = await json('/api/auth/entrar', { usuario: 'caro@ejemplo.mx', codigo: reg.codigo_prueba });
    expect(bueno.estado).toBe(200); expect(bueno.cookie).toMatch(/^fsm=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  });
  it('pedir código de una cuenta que no existe no delata nada', async () => {
    const r = await json('/api/auth/codigo', { usuario: 'nadie' });
    expect(r.estado).toBe(200); expect(r.enviado).toBe(false); expect(r.codigo_prueba).toBeUndefined();
  });
  it('sin sesión la API contesta 401 y salir mata la cookie', async () => {
    expect((await json('/api/dominios')).estado).toBe(401);
    const { cookie } = await cuentaNueva('dani');
    expect((await json('/api/auth/salir', {}, { cookie })).estado).toBe(200);
    expect((await json('/api/yo', undefined, { cookie })).estado).toBe(401);
  });
});
