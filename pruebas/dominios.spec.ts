import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E, cuentaNueva, direccion, json, registrosResend, fetchDeMentira, sinPendientes, esperaResend, esperaUrl } from './ayuda';

beforeAll(() => fetchDeMentira());
afterEach(() => sinPendientes());

describe('dominios y direcciones', () => {
  it('da de alta el dominio en Resend con recepción y guarda los registros DNS para el dueño', async () => {
    const { cookie } = await cuentaNueva('u-d1');
    let pedido: any;
    esperaResend('GET', '/domains', { data: [] });
    esperaResend('POST', '/domains', { id: 'rs_1', name: 'negocio.com', status: 'not_started', records: registrosResend('negocio.com') }, { estado: 200, capturar: (b) => { pedido = b; } });
    const r = await json('/api/dominios', { dominio: 'https://WWW.Negocio.com/' }, { cookie });
    expect(r.estado).toBe(201);
    expect(pedido).toEqual({ name: 'negocio.com', capabilities: { sending: 'enabled', receiving: 'enabled' } });
    expect(r.dominio.dominio).toBe('negocio.com'); expect(r.dominio.estado).toBe('pendiente');
    expect(r.dominio.registros.map((x: any) => x.type)).toEqual(['TXT', 'MX', 'TXT', 'MX']);
    const lista = await json('/api/dominios', undefined, { cookie });
    expect(lista.dominios).toHaveLength(1); expect(lista.dominios[0].direcciones).toEqual([]);
  });
  it('dominio inválido y repetido', async () => {
    const { cookie } = await cuentaNueva('u-d2');
    expect((await json('/api/dominios', { dominio: 'no es' }, { cookie })).error).toBe('dominio_invalido');
    esperaResend('GET', '/domains', { data: [] });
    esperaResend('POST', '/domains', { id: 'rs_2', name: 'dos.com', status: 'pending', records: [] });
    expect((await json('/api/dominios', { dominio: 'dos.com' }, { cookie })).estado).toBe(201);
    expect((await json('/api/dominios', { dominio: 'dos.com' }, { cookie })).error).toBe('dominio_ya_agregado');
    const otra = await cuentaNueva('u-d2b');
    expect((await json('/api/dominios', { dominio: 'dos.com' }, { cookie: otra.cookie })).error).toBe('dominio_de_otra_cuenta');
  });
  it('si Resend falla, lo dice y no guarda nada', async () => {
    const { cookie } = await cuentaNueva('u-d3');
    esperaResend('GET', '/domains', { data: [] });
    esperaResend('POST', '/domains', { message: 'Domain limit reached' }, { estado: 422 });
    const r = await json('/api/dominios', { dominio: 'tres.com' }, { cookie });
    expect(r.estado).toBe(503); expect(r.error).toBe('cartero_fallo'); expect(r.detalle).toContain('limit');
    expect((await json('/api/dominios', undefined, { cookie })).dominios).toHaveLength(0);
  });
  it('verificar pide la revisión a Resend y actualiza estado y registros', async () => {
    const { cookie } = await cuentaNueva('u-d4');
    esperaResend('GET', '/domains', { data: [] });
    esperaResend('POST', '/domains', { id: 'rs_4', name: 'cuatro.com', status: 'not_started', records: registrosResend('cuatro.com') });
    const d = (await json('/api/dominios', { dominio: 'cuatro.com' }, { cookie })).dominio;
    esperaResend('POST', '/domains/rs_4/verify', { object: 'domain', id: 'rs_4' });
    esperaResend('GET', '/domains/rs_4', { id: 'rs_4', name: 'cuatro.com', status: 'verified', records: registrosResend('cuatro.com').map((x) => ({ ...x, status: 'verified' })) });
    const v = await json(`/api/dominios/${d.id}/verificar`, {}, { cookie });
    expect(v.estado).toBe(200); expect(v.dominio.estado).toBe('verificado'); expect(v.dominio.verificada_at).toBeTruthy();
    expect(v.dominio.registros.every((x: any) => x.status === 'verified')).toBe(true);
  });
  it('direcciones: alta, repetida, inválida, desactivar', async () => {
    const { cookie } = await cuentaNueva('u-d5');
    esperaResend('GET', '/domains', { data: [] });
    esperaResend('POST', '/domains', { id: 'rs_5', name: 'cinco.com', status: 'pending', records: [] });
    const d = (await json('/api/dominios', { dominio: 'cinco.com' }, { cookie })).dominio;
    const v = await direccion(cookie, d.id, 'Ventas@cinco.com', 'Ventas Cinco');
    expect(v.correo).toBe('ventas@cinco.com');
    expect((await json(`/api/dominios/${d.id}/direcciones`, { local: 'ventas' }, { cookie })).error).toBe('direccion_ya_existe');
    expect((await json(`/api/dominios/${d.id}/direcciones`, { local: 'con espacio' }, { cookie })).error).toBe('direccion_invalida');
    const p = await json(`/api/dominios/${d.id}/direcciones/${v.id}`, { activa: false }, { cookie, metodo: 'PATCH' });
    expect(p.direccion.activa).toBe(false);
    const otra = await cuentaNueva('u-d5b');
    expect((await json(`/api/dominios/${d.id}/direcciones`, { local: 'x' }, { cookie: otra.cookie })).estado).toBe(404);
  });
});

describe('el cron de dominios pendientes', () => {
  it('pregunta a Resend por cada pendiente y marca verificado sin que nadie toque nada', async () => {
    const { cookie } = await cuentaNueva('u-cron');
    esperaResend('GET', '/domains', { data: [] });
    esperaResend('POST', '/domains', { id: 'rs_cron', name: 'cron.mx', status: 'not_started', records: registrosResend('cron.mx') });
    const d = (await json('/api/dominios', { dominio: 'cron.mx' }, { cookie })).dominio;
    esperaResend('POST', '/domains/rs_cron/verify', { object: 'domain', id: 'rs_cron' });
    esperaResend('GET', '/domains/rs_cron', { id: 'rs_cron', name: 'cron.mx', status: 'verified', records: registrosResend('cron.mx').map((x) => ({ ...x, status: 'verified' })) });
    const { refrescarPendientes } = await import('../src/dominios');
    const r = await refrescarPendientes(E);
    expect(r.revisados).toBeGreaterThanOrEqual(1); expect(r.cambiados).toBe(1);
    const lista = await json('/api/dominios', undefined, { cookie });
    expect(lista.dominios.find((x: any) => x.id === d.id).estado).toBe('verificado');
    // Ya verificado, el cron no lo vuelve a preguntar.
    const otra = await refrescarPendientes(E);
    expect(otra.cambiados).toBe(0);
  });
});

describe('el cron no reinicia una verificación en curso', () => {
  it('con registros pending sólo lee; con not_started o failed pide verificar', async () => {
    const { hayQuePedirVerificacion } = await import('../src/dominios');
    expect(hayQuePedirVerificacion('[]')).toBe(true);
    expect(hayQuePedirVerificacion(JSON.stringify([{ status: 'pending' }, { status: 'verified' }]))).toBe(false);
    expect(hayQuePedirVerificacion(JSON.stringify([{ status: 'pending' }, { status: 'not_started' }]))).toBe(true);
    expect(hayQuePedirVerificacion(JSON.stringify([{ status: 'failed' }]))).toBe(true);
    const { cookie } = await cuentaNueva('u-cron2');
    esperaResend('GET', '/domains', { data: [] });
    esperaResend('POST', '/domains', { id: 'rs_c2', name: 'cron2.mx', status: 'pending', records: registrosResend('cron2.mx').map((x) => ({ ...x, status: 'pending' })) });
    await json('/api/dominios', { dominio: 'cron2.mx' }, { cookie });
    // Sólo el GET: si el cron pidiera /verify, sinPendientes() lo acusaría como llamada no anunciada.
    esperaResend('GET', '/domains/rs_c2', { id: 'rs_c2', name: 'cron2.mx', status: 'pending', records: registrosResend('cron2.mx').map((x) => ({ ...x, status: 'pending' })) });
    const { refrescarPendientes } = await import('../src/dominios');
    const r = await refrescarPendientes(E);
    expect(r.cambiados).toBe(0);
  });
});

describe('un dominio que ya está en Resend se reusa', () => {
  it('no lo crea: le prende la recepción y toma sus registros y su estado', async () => {
    const { cookie } = await cuentaNueva('u-reusa');
    esperaResend('GET', '/domains', { data: [{ id: 'rs_kranko', name: 'kranko.app', status: 'verified' }] });
    esperaResend('PATCH', '/domains/rs_kranko', { id: 'rs_kranko', name: 'kranko.app', status: 'verified', records: [] });
    esperaResend('GET', '/domains/rs_kranko', { id: 'rs_kranko', name: 'kranko.app', status: 'verified', records: [...registrosResend('kranko.app').map((x) => ({ ...x, status: 'verified' })), { record: 'Receiving', name: 'kranko.app', type: 'MX', value: 'receive.forge.rmta.net', priority: 10, status: 'not_started' }] });
    const r = await json('/api/dominios', { dominio: 'kranko.app' }, { cookie });
    expect(r.estado).toBe(201); expect(r.reusado).toBe(true);
    expect(r.dominio.estado).toBe('verificado'); expect(r.dominio.verificada_at).toBeTruthy();
    expect(r.dominio.registros.find((x: any) => x.record === 'Receiving').status).toBe('not_started');
  });
});
