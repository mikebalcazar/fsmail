import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { E, cuentaNueva, direccion, dominioVerificado, json, recibido, webhook, fetchDeMentira, sinPendientes, esperaResend, esperaUrl } from './ayuda';

beforeAll(() => fetchDeMentira());
afterEach(() => sinPendientes());

describe('el webhook de Resend', () => {
  it('sin firma válida → 401 y no toca Resend', async () => {
    const r = await webhook({ type: 'email.received', data: { email_id: 'x' } }, { secreto: 'whsec_b3Ryby1zZWNyZXRv' });
    expect(r.estado).toBe(401);
    const vieja = await webhook({ type: 'email.received', data: { email_id: 'x' } }, { ts: String(Math.floor(Date.now() / 1000) - 3600) });
    expect(vieja.estado).toBe(401);
  });
  it('otros eventos se aceptan y se ignoran', async () => {
    const r = await webhook({ type: 'email.sent', data: { email_id: 'x' } });
    expect(r.estado).toBe(200); expect(r.ignorado).toBe('email.sent');
  });
  it('un correo a una dirección dada de alta queda en su bandeja, con cuerpo en R2 y adjunto', async () => {
    const { cookie, cuenta } = await cuentaNueva('u-w1');
    const d = await dominioVerificado(cookie, 'tacos.mx');
    const ventas = await direccion(cookie, d.id, 'ventas', 'Ventas Tacos');
    esperaResend('GET', '/emails/receiving/em_1', recibido({
      id: 'em_1', para: ['ventas@tacos.mx'], asunto: 'Pedido grande', texto: 'Quiero 200 tacos.',
      adjuntos: [{ id: 'at_1', filename: 'lista.pdf', content_type: 'application/pdf', content_disposition: 'attachment', content_id: null }],
    }));
    esperaResend('GET', '/emails/receiving/em_1/attachments/at_1', { id: 'at_1', filename: 'lista.pdf', size: 11, content_type: 'application/pdf', content_disposition: 'attachment', content_id: null, download_url: 'https://inbound-cdn.resend.com/em_1/at_1', expires_at: '2099-01-01T00:00:00Z' });
    esperaUrl('GET', 'https://inbound-cdn.resend.com/em_1/at_1', '%PDF-prueba', { 'content-type': 'application/pdf' });

    const w = await webhook({ type: 'email.received', created_at: '2026-10-22T10:00:02Z', data: { email_id: 'em_1', from: 'cliente@gmail.com', to: ['ventas@tacos.mx'], subject: 'Pedido grande' } });
    expect(w.estado).toBe(200); expect(w.guardados).toBe(1);

    const conteos = await json('/api/mensajes/conteos', undefined, { cookie });
    expect(conteos.conteos).toEqual([{ dominio_id: d.id, direccion_id: ventas.id, total: 1, sin_leer: 1 }]);
    const lista = await json(`/api/mensajes?dominio=${d.id}&direccion=${ventas.id}`, undefined, { cookie });
    expect(lista.mensajes).toHaveLength(1);
    const m = lista.mensajes[0];
    expect(m).toMatchObject({ de: 'cliente@gmail.com', de_nombre: 'Cliente Uno', asunto: 'Pedido grande', resumen: 'Quiero 200 tacos.', leido: false, adjuntos: 1, para: ['ventas@tacos.mx'] });
    expect(m.fecha).toBe('2026-10-22T10:00:00.000Z');

    const uno = await json(`/api/mensajes/${m.id}`, undefined, { cookie });
    expect(uno.contenido.html).toContain('<b>¿me pasan precio?</b>'); expect(uno.contenido.text).toBe('Quiero 200 tacos.');
    expect(uno.mensaje.autenticacion).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    expect(uno.adjuntos).toHaveLength(1);
    expect(await E.CORREO.get(`c/${cuenta.id}/m/${m.id}.json`)).not.toBeNull();
    const a = await SELF.fetch(`https://fsmail.test/api/mensajes/${m.id}/adjuntos/${uno.adjuntos[0].id}`, { headers: { Cookie: cookie } });
    expect(a.status).toBe(200); expect(a.headers.get('content-disposition')).toContain('lista.pdf'); expect(await a.text()).toBe('%PDF-prueba');
    // Abrirlo lo marcó leído.
    expect((await json('/api/mensajes/conteos', undefined, { cookie })).conteos[0].sin_leer).toBe(0);
    // El mismo webhook otra vez no duplica.
    const w2 = await webhook({ type: 'email.received', data: { email_id: 'em_1' } });
    expect(w2.guardados).toBe(0); expect(w2.motivo).toBe('duplicado');
  });
  it('a una dirección NO dada de alta: se guarda «sin dirección» y al crearla se le asigna', async () => {
    const { cookie } = await cuentaNueva('u-w2');
    const d = await dominioVerificado(cookie, 'flores.mx');
    esperaResend('GET', '/emails/receiving/em_2', recibido({ id: 'em_2', para: ['info@flores.mx'], asunto: 'Hola' }));
    expect((await webhook({ type: 'email.received', data: { email_id: 'em_2' } })).guardados).toBe(1);
    expect((await json('/api/mensajes/conteos', undefined, { cookie })).conteos).toEqual([{ dominio_id: d.id, direccion_id: null, total: 1, sin_leer: 1 }]);
    expect((await json(`/api/mensajes?dominio=${d.id}&direccion=ninguna`, undefined, { cookie })).mensajes).toHaveLength(1);
    const info = await direccion(cookie, d.id, 'info');
    expect((await json('/api/mensajes/conteos', undefined, { cookie })).conteos).toEqual([{ dominio_id: d.id, direccion_id: info.id, total: 1, sin_leer: 1 }]);
  });
  it('un dominio que no es de nadie no se guarda; uno de otra cuenta no se ve', async () => {
    const a = await cuentaNueva('u-w3a'); const b = await cuentaNueva('u-w3b');
    const da = await dominioVerificado(a.cookie, 'a-tres.mx');
    await direccion(a.cookie, da.id, 'hola');
    esperaResend('GET', '/emails/receiving/em_3', recibido({ id: 'em_3', para: ['x@desconocido.com'] }));
    expect((await webhook({ type: 'email.received', data: { email_id: 'em_3' } })).motivo).toBe('sin_dominio');
    esperaResend('GET', '/emails/receiving/em_4', recibido({ id: 'em_4', para: ['hola@a-tres.mx'] }));
    expect((await webhook({ type: 'email.received', data: { email_id: 'em_4' } })).guardados).toBe(1);
    expect((await json('/api/mensajes', undefined, { cookie: b.cookie })).mensajes).toHaveLength(0);
    const ma = (await json('/api/mensajes', undefined, { cookie: a.cookie })).mensajes[0];
    expect((await json(`/api/mensajes/${ma.id}`, undefined, { cookie: b.cookie })).estado).toBe(404);
  });
  it('las respuestas caen en el mismo hilo y la búsqueda encuentra por asunto', async () => {
    const { cookie } = await cuentaNueva('u-w4');
    const d = await dominioVerificado(cookie, 'hilos.mx');
    await direccion(cookie, d.id, 'soporte');
    esperaResend('GET', '/emails/receiving/em_5', recibido({ id: 'em_5', para: ['soporte@hilos.mx'], asunto: 'Falla', message_id: '<raiz@gmail.com>' }));
    esperaResend('GET', '/emails/receiving/em_6', recibido({ id: 'em_6', para: ['soporte@hilos.mx'], asunto: 'Re: Falla', message_id: '<hijo@gmail.com>', in_reply_to: '<raiz@gmail.com>', texto: 'Sigue igual' }));
    esperaResend('GET', '/emails/receiving/em_7', recibido({ id: 'em_7', para: ['soporte@hilos.mx'], asunto: 'Otra cosa', message_id: '<otro@gmail.com>' }));
    for (const id of ['em_5', 'em_6', 'em_7']) await webhook({ type: 'email.received', data: { email_id: id } });
    const todos = (await json('/api/mensajes', undefined, { cookie })).mensajes;
    expect(todos).toHaveLength(3);
    const hilos = new Set(todos.map((m: any) => m.hilo_id));
    expect(hilos.size).toBe(2);
    expect(todos.find((m: any) => m.asunto === 'Re: Falla').hilo_id).toBe(todos.find((m: any) => m.asunto === 'Falla').hilo_id);
    expect((await json('/api/mensajes?q=otra', undefined, { cookie })).mensajes.map((m: any) => m.asunto)).toEqual(['Otra cosa']);
    expect((await json('/api/mensajes?q=igual', undefined, { cookie })).mensajes.map((m: any) => m.asunto)).toEqual(['Re: Falla']);
  });
});

describe('enviar y responder', () => {
  it('sale por Resend desde la dirección, con el nombre, y queda en enviados', async () => {
    const { cookie } = await cuentaNueva('u-e1');
    const d = await dominioVerificado(cookie, 'envia.mx');
    const v = await direccion(cookie, d.id, 'ventas', 'Ventas Envía');
    let pedido: any;
    esperaResend('POST', '/emails', { id: 'env_1' }, { estado: 200, capturar: (b) => { pedido = b; } });
    const r = await json('/api/mensajes/enviar', { direccion_id: v.id, para: 'cliente@gmail.com, otro@x.mx', asunto: 'Su cotización', texto: 'Adjunto precios.' }, { cookie });
    expect(r.estado).toBe(201);
    expect(pedido.from).toBe('Ventas Envía <ventas@envia.mx>'); expect(pedido.to).toEqual(['cliente@gmail.com', 'otro@x.mx']); expect(pedido.text).toBe('Adjunto precios.'); expect(pedido.headers['In-Reply-To']).toBeUndefined();
    const env = (await json('/api/mensajes?carpeta=enviados', undefined, { cookie })).mensajes;
    expect(env).toHaveLength(1); expect(env[0]).toMatchObject({ de: 'ventas@envia.mx', para: ['cliente@gmail.com', 'otro@x.mx'], leido: true, carpeta: 'enviados' });
    expect((await json('/api/mensajes', undefined, { cookie })).mensajes).toHaveLength(0);
  });
  it('responder lleva In-Reply-To y References y se queda en el hilo del original', async () => {
    const { cookie } = await cuentaNueva('u-e2');
    const d = await dominioVerificado(cookie, 'resp.mx');
    const v = await direccion(cookie, d.id, 'hola');
    esperaResend('GET', '/emails/receiving/em_9', recibido({ id: 'em_9', para: ['hola@resp.mx'], asunto: 'Duda', message_id: '<duda@gmail.com>' }));
    await webhook({ type: 'email.received', data: { email_id: 'em_9' } });
    const orig = (await json('/api/mensajes', undefined, { cookie })).mensajes[0];
    let pedido: any;
    esperaResend('POST', '/emails', { id: 'env_2' }, { estado: 200, capturar: (b) => { pedido = b; } });
    const r = await json('/api/mensajes/enviar', { direccion_id: v.id, para: ['cliente@gmail.com'], asunto: 'Re: Duda', texto: 'Resuelto.', en_respuesta_a: orig.id }, { cookie });
    expect(r.estado).toBe(201); expect(r.mensaje.hilo_id).toBe(orig.hilo_id);
    expect(pedido.headers['In-Reply-To']).toBe('<duda@gmail.com>'); expect(pedido.headers['References']).toBe('<duda@gmail.com>');
    expect((await json(`/api/mensajes?carpeta=enviados&hilo=${orig.hilo_id}`, undefined, { cookie })).mensajes).toHaveLength(1);
  });
  it('no se envía desde dominio sin verificar, dirección inactiva o destinatario inválido', async () => {
    const { cookie } = await cuentaNueva('u-e3');
    esperaResend('POST', '/domains', { id: 'rs_e3', name: 'pend.mx', status: 'pending', records: [] });
    const d = (await json('/api/dominios', { dominio: 'pend.mx' }, { cookie })).dominio;
    const v = await direccion(cookie, d.id, 'x');
    expect((await json('/api/mensajes/enviar', { direccion_id: v.id, para: 'a@b.mx', asunto: 'x', texto: 'y' }, { cookie })).error).toBe('dominio_sin_verificar');
    await E.DB.prepare(`UPDATE dominios SET estado = 'verificado' WHERE id = ?`).bind(d.id).run();
    expect((await json('/api/mensajes/enviar', { direccion_id: v.id, para: 'no-correo', asunto: 'x', texto: 'y' }, { cookie })).error).toBe('destinatario_invalido');
    expect((await json('/api/mensajes/enviar', { direccion_id: v.id, para: 'a@b.mx', asunto: 'x', texto: '  ' }, { cookie })).error).toBe('mensaje_vacio');
    await json(`/api/dominios/${d.id}/direcciones/${v.id}`, { activa: false }, { cookie, metodo: 'PATCH' });
    expect((await json('/api/mensajes/enviar', { direccion_id: v.id, para: 'a@b.mx', asunto: 'x', texto: 'y' }, { cookie })).error).toBe('direccion_inactiva');
  });
  it('mover a archivo y basura, y de regreso', async () => {
    const { cookie } = await cuentaNueva('u-e4');
    const d = await dominioVerificado(cookie, 'mueve.mx'); await direccion(cookie, d.id, 'a');
    esperaResend('GET', '/emails/receiving/em_10', recibido({ id: 'em_10', para: ['a@mueve.mx'] }));
    await webhook({ type: 'email.received', data: { email_id: 'em_10' } });
    const m = (await json('/api/mensajes', undefined, { cookie })).mensajes[0];
    await json(`/api/mensajes/${m.id}`, { carpeta: 'archivo' }, { cookie, metodo: 'PATCH' });
    expect((await json('/api/mensajes', undefined, { cookie })).mensajes).toHaveLength(0);
    expect((await json('/api/mensajes?carpeta=archivo', undefined, { cookie })).mensajes).toHaveLength(1);
    await json(`/api/mensajes/${m.id}`, { carpeta: 'entrada', leido: false }, { cookie, metodo: 'PATCH' });
    expect((await json('/api/mensajes/conteos', undefined, { cookie })).conteos[0].sin_leer).toBe(1);
  });
});
