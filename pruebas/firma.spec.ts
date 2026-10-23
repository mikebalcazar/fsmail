import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { armarFirma, telefonoWhatsapp, sitioLimpio, textoAHtml } from '../src/firma';
import { cuentaNueva, direccion, dominioVerificado, json, fetchDeMentira, sinPendientes, esperaResend } from './ayuda';

beforeAll(() => fetchDeMentira());
afterEach(() => sinPendientes());

describe('el banner de firma', () => {
  it('teléfono a WhatsApp: 10 dígitos = México, con lada se respeta, basura no', () => {
    expect(telefonoWhatsapp('55 1234 5678')).toBe('525512345678');
    expect(telefonoWhatsapp('+52 1 55 1234 5678')).toBe('5215512345678');
    expect(telefonoWhatsapp('+1 (305) 555-0100')).toBe('13055550100');
    expect(telefonoWhatsapp('123')).toBeNull(); expect(telefonoWhatsapp('')).toBeNull();
  });
  it('sitio: acepta con o sin https, rechaza lo que no es URL', () => {
    expect(sitioLimpio('kranko.app')).toBe('https://kranko.app');
    expect(sitioLimpio('https://vigifield.com/')).toBe('https://vigifield.com');
    expect(sitioLimpio('javascript:alert(1)')).toBeNull();
  });
  it('arma las ligas: logo → sitio, nombre → mailto, teléfono → wa.me, sitio → sitio; y la versión en texto', () => {
    const f = armarFirma({ local: 'mike', dominio: 'kranko.app', dominio_id: 'dom1', origen: 'https://mailing.forespot.com',
      marca: { nombre: 'Kranko', sitio: 'https://kranko.app', color: '#ff6600', logo: true }, firma: { nombre: 'Mike Balcázar', puesto: 'Director', telefono: '55 1234 5678' } });
    expect(f.hay).toBe(true);
    expect(f.html).toContain('<a href="https://kranko.app"'); expect(f.html).toContain('src="https://mailing.forespot.com/marca/dom1/logo"');
    expect(f.html).toContain('href="mailto:mike@kranko.app"'); expect(f.html).toContain('href="https://wa.me/525512345678"');
    expect(f.html).toContain('Mike Balcázar'); expect(f.html).toContain('Director'); expect(f.html).toContain('#ff6600');
    expect(f.html).not.toContain('<script');
    expect(f.texto).toBe('--\nMike Balcázar\nDirector · Kranko\nTel/WhatsApp: 55 1234 5678 (https://wa.me/525512345678)\nmike@kranko.app\nhttps://kranko.app');
  });
  it('sin datos no hay firma; sin logo no hay imagen; escapa HTML del usuario', () => {
    expect(armarFirma({ local: 'a', dominio: 'b.mx', dominio_id: 'x', origen: 'https://o', marca: {}, firma: {} }).hay).toBe(false);
    const f = armarFirma({ local: 'a', dominio: 'b.mx', dominio_id: 'x', origen: 'https://o', marca: {}, firma: { nombre: '<b>Ana</b>' } });
    expect(f.html).not.toContain('<img'); expect(f.html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
  });
  it('texto → HTML con párrafos y escapado', () => {
    expect(textoAHtml('Hola <Ana>\nbien\n\nSaludos')).toBe('<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111827"><p style="margin:0 0 12px">Hola &lt;Ana&gt;<br>bien</p><p style="margin:0 0 12px">Saludos</p></div>');
  });
});

describe('marca y firma por la API', () => {
  it('marca del dominio: nombre, sitio y color; logo subido y servido público; la dirección nace con firma y se envía con ella', async () => {
    const { cookie } = await cuentaNueva('u-firma');
    const d = await dominioVerificado(cookie, 'kranko.app');
    expect((await json(`/api/dominios/${d.id}`, { marca: { sitio: 'no es url' } }, { cookie, metodo: 'PATCH' })).error).toBe('sitio_invalido');
    expect((await json(`/api/dominios/${d.id}`, { marca: { color: 'rojo' } }, { cookie, metodo: 'PATCH' })).error).toBe('color_invalido');
    const m = await json(`/api/dominios/${d.id}`, { marca: { nombre: 'Kranko', sitio: 'kranko.app', color: '#ff6600' } }, { cookie, metodo: 'PATCH' });
    expect(m.marca).toEqual({ nombre: 'Kranko', sitio: 'https://kranko.app', color: '#ff6600' });

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const malo = await SELF.fetch(`https://fsmail.test/api/dominios/${d.id}/logo`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'text/html' }, body: 'x' });
    expect(malo.status).toBe(400);
    const sube = await SELF.fetch(`https://fsmail.test/api/dominios/${d.id}/logo`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'image/png' }, body: png });
    expect(sube.status).toBe(200);
    const publico = await SELF.fetch(`https://fsmail.test/marca/${d.id}/logo`);
    expect(publico.status).toBe(200); expect(publico.headers.get('content-type')).toBe('image/png'); expect(new Uint8Array(await publico.arrayBuffer())).toEqual(png);
    expect((await SELF.fetch('https://fsmail.test/marca/no-existe/logo')).status).toBe(404);

    const r = await json(`/api/dominios/${d.id}/direcciones`, { local: 'mike', firma: { nombre: 'Mike Balcázar', puesto: 'Director', telefono: '5512345678' } }, { cookie });
    expect(r.estado).toBe(201); expect(r.direccion.nombre).toBe('Mike Balcázar'); expect(r.direccion.firma).toEqual({ nombre: 'Mike Balcázar', puesto: 'Director', telefono: '5512345678' });
    const f = await json(`/api/dominios/${d.id}/direcciones/${r.direccion.id}/firma`, undefined, { cookie });
    expect(f.hay).toBe(true); expect(f.html).toContain('wa.me/525512345678'); expect(f.html).toContain(`/marca/${d.id}/logo`);
    const previa = await json(`/api/dominios/${d.id}/firma-previa`, { local: 'ventas', firma: { nombre: 'Ana' }, marca: { color: '#112233' } }, { cookie });
    expect(previa.html).toContain('mailto:ventas@kranko.app'); expect(previa.html).toContain('#112233');

    let pedido: any;
    esperaResend('POST', '/emails', { id: 'env_f' }, { capturar: (b) => { pedido = b; } });
    const e = await json('/api/mensajes/enviar', { direccion_id: r.direccion.id, para: 'cliente@gmail.com', asunto: 'Hola', texto: 'Te mando la cotización.\n\nSaludos' }, { cookie });
    expect(e.estado).toBe(201);
    expect(pedido.text).toBe('Te mando la cotización.\n\nSaludos\n\n--\nMike Balcázar\nDirector · Kranko\nTel/WhatsApp: 5512345678 (https://wa.me/525512345678)\nmike@kranko.app\nhttps://kranko.app');
    expect(pedido.html).toContain('<p style="margin:0 0 12px">Te mando la cotización.</p>'); expect(pedido.html).toContain('href="https://wa.me/525512345678"');
    const guardado = await json(`/api/mensajes/${e.mensaje.id}`, undefined, { cookie });
    expect(guardado.contenido.html).toContain('wa.me');

    const quita = await json(`/api/dominios/${d.id}/logo`, undefined, { cookie, metodo: 'DELETE' });
    expect(quita.marca.logo).toBeUndefined();
    expect((await SELF.fetch(`https://fsmail.test/marca/${d.id}/logo`)).status).toBe(404);
  });
  it('sin firma, el envío va como antes: sólo texto', async () => {
    const { cookie } = await cuentaNueva('u-sinfirma');
    const d = await dominioVerificado(cookie, 'plano.mx');
    const v = await direccion(cookie, d.id, 'a');
    let pedido: any;
    esperaResend('POST', '/emails', { id: 'env_p' }, { capturar: (b) => { pedido = b; } });
    await json('/api/mensajes/enviar', { direccion_id: v.id, para: 'x@y.mx', asunto: 'x', texto: 'solo texto' }, { cookie });
    expect(pedido.text).toBe('solo texto'); expect(pedido.html).toBeUndefined();
  });
});
