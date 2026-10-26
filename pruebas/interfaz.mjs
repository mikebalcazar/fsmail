#!/usr/bin/env node
/* Mide la interfaz en Chromium con la API simulada: carga src/ui.html, abre
 * un mensaje, el diálogo de redactar con adjuntos y la vista móvil, y guarda
 * capturas. Falla si la página lanza errores. No corre en CI (necesita
 * Chromium); se corre a mano: node pruebas/interfaz.mjs <carpeta-salida>. */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(aqui, '..', 'src', 'ui.html'), 'utf8');
const salida = process.argv[2] || join(aqui, '..', 'capturas');
mkdirSync(salida, { recursive: true });
const ejecutable = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const doms = [
  { id: 'd1', dominio: 'kranko.app', estado: 'verificado', marca: { nombre: 'Kranko', color: '#ff6600', sitio: 'https://kranko.app' }, registros: [], direcciones: [{ id: 'a1', local: 'mike', nombre: 'Mike', activa: true, correo: 'mike@kranko.app', firma: { nombre: 'Mike Balcázar', puesto: 'Director' } }, { id: 'a2', local: 'ventas', activa: true, correo: 'ventas@kranko.app', firma: {} }] },
  { id: 'd2', dominio: 'vigifield.com', estado: 'verificado', marca: { nombre: 'VigiField', color: '#0984e3' }, registros: [], direcciones: [{ id: 'b1', local: 'hola', activa: true, correo: 'hola@vigifield.com', firma: {} }] },
  { id: 'd3', dominio: 'eskol.app', estado: 'pendiente', marca: {}, registros: [{ record: 'MX', type: 'MX', name: 'eskol.app', value: 'receive.forge.rmta.net', priority: 10, status: 'pending' }], direcciones: [] },
];
const mensajes = Array.from({ length: 7 }, (_, i) => ({ id: 'm' + i, hilo_n: i === 0 ? 3 : 1, dominio_id: i % 2 ? 'd2' : 'd1', direccion_id: i === 2 ? null : i % 2 ? 'b1' : 'a1', hilo_id: 'h' + i, de: ['brooklyn@whitecompany.com', 'alex@team.io', 'no-reply@spotify.com', 'michael@sergey.dev'][i % 4], de_nombre: ['Brooklyn Simmons', 'Alex S. Liza E.', 'Spotify', 'Michael B. Sergey'][i % 4], para: ['mike@kranko.app'], asunto: ['Mobile Booking Design Edits 🚀', 'Team Meeting', 'Unidentified device', 'Working build'][i % 4], resumen: 'Hello, Vitaliy! We really like the design of the application you sent us. To understand the completeness…', fecha: new Date(Date.now() - i * 3.6e6 * 5).toISOString(), carpeta: 'entrada', leido: i > 1, adjuntos: i % 3 === 0 ? 3 : 0 }));
const rutas = {
  '/api/yo': { ok: true, cuenta: { id: 'c', username: 'mikebalcazar', correo: 'mike@ejemplo.com', nombre: 'Mike Balcázar' } },
  '/api/dominios': { ok: true, dominios: doms },
  '/api/mensajes/conteos': { ok: true, conteos: [{ dominio_id: 'd1', direccion_id: 'a1', total: 9, sin_leer: 4 }, { dominio_id: 'd1', direccion_id: 'a2', total: 3, sin_leer: 0 }, { dominio_id: 'd2', direccion_id: 'b1', total: 4, sin_leer: 2 }, { dominio_id: 'd2', direccion_id: null, total: 1, sin_leer: 1 }],
    carpetas: [{ dominio_id: 'd1', direccion_id: 'a1', carpeta: 'entrada', total: 9, sin_leer: 4 }, { dominio_id: 'd1', direccion_id: 'a1', carpeta: 'enviados', total: 5, sin_leer: 0 }, { dominio_id: 'd1', direccion_id: 'a1', carpeta: 'archivo', total: 12, sin_leer: 0 }, { dominio_id: 'd1', direccion_id: 'a2', carpeta: 'entrada', total: 3, sin_leer: 0 }, { dominio_id: 'd2', direccion_id: 'b1', carpeta: 'entrada', total: 4, sin_leer: 2 }, { dominio_id: 'd2', direccion_id: 'b1', carpeta: 'basura', total: 2, sin_leer: 0 }, { dominio_id: 'd2', direccion_id: null, carpeta: 'entrada', total: 1, sin_leer: 1 }] },
  '/api/mensajes/m2': { ok: true, mensaje: { ...mensajes[2], autenticacion: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } }, contenido: { html: null, text: 'Hola, ¿tienen disponibilidad para el jueves?' }, adjuntos: [] },
  '/api/mensajes/m0': { ok: true, mensaje: { ...mensajes[0], autenticacion: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } }, contenido: { html: '<p>Hello, Vitaliy!</p><p>We really like the design of the application you sent us. To understand the completeness of the project, I will send you the old design of the app. There you can see the current state of the project.</p><p><b>Brooklyn Simmons, CPO</b><br>Site: <a href="#">whitecompany.com</a></p>', text: 'Hello' }, adjuntos: [{ id: 'x1', nombre: 'Payment Data.pdf', tipo: 'application/pdf', tamano: 17000 }, { id: 'x2', nombre: 'Booking App.fig', tipo: 'application/octet-stream', tamano: 327000 }, { id: 'x3', nombre: 'UX-Flow.zip', tipo: 'application/zip', tamano: 204000 }] },
};
let enviado = null, usada = false;
const b = await chromium.launch({ executablePath: ejecutable });
const resultados = [];
for (const [nombre, vp] of [['escritorio', { width: 1440, height: 900 }], ['movil', { width: 390, height: 844 }]]) {
  const p = await b.newPage({ viewport: vp });
  await p.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/') return r.fulfill({ contentType: 'text/html', body: html });
    if (/^\/api\/mensajes\/(m\d+)\/hilo$/.test(u.pathname)) {
      const mid = u.pathname.split('/')[3]; const base = rutas['/api/mensajes/' + mid] || { mensaje: mensajes.find((x) => x.id === mid), contenido: { html: null, text: 'Texto del correo.' }, adjuntos: [] };
      const mio = { mensaje: { ...base.mensaje, id: mid + '-r', carpeta: 'enviados', de: 'mike@kranko.app', de_nombre: 'Mike', para: [base.mensaje.de], resumen: 'Claro, te mando la propuesta mañana.', fecha: new Date(Date.parse(base.mensaje.fecha) + 36e5).toISOString() }, contenido: { html: null, text: 'Claro, te mando la propuesta mañana.' }, adjuntos: [] };
      const otro = { mensaje: { ...base.mensaje, id: mid + '-2', resumen: 'Perfecto, quedo pendiente. ¡Gracias!', fecha: new Date(Date.parse(base.mensaje.fecha) + 72e5).toISOString() }, contenido: { html: null, text: 'Perfecto, quedo pendiente. ¡Gracias!' }, adjuntos: [] };
      const conv = mid === 'm0' ? [base, mio, otro] : [base];
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, hilo: { id: 'h', asunto: base.mensaje.asunto, total: conv.length }, mensajes: conv, marcados_leidos: [] }) });
    }
    // El asistente: el hilo de m0 trae respuesta sugerida; los demás, sólo «disponible».
    if (/^\/api\/asistente\/mensajes\/[\w-]+$/.test(u.pathname)) {
      const mid = u.pathname.split('/')[4];
      const sugerencia = mid.startsWith('m0') ? { id: 's1', mensaje_id: 'm0-2', estado: 'lista', categoria: 'venta', humano: false, motivo: null, texto: 'Hola, Brooklyn. Con gusto: el plan Jornada cuesta $300 al mes con 10 trabajadores incluidos.', error: null } : null;
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, sugerencia, disponible: true, mensaje_cliente: mid, con_llave: true }) });
    }
    if (/^\/api\/asistente\/sugerencias\/s1\/usada$/.test(u.pathname)) { usada = true; return r.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); }
    if (u.pathname === '/api/asistente/direcciones/b1') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, asistente: { direccion_id: 'b1', activo: true, modo: 'borrador', instrucciones: 'Trata de usted.', conocimiento: '# Vigifield\n\nControl de asistencia con GPS.\nPlan Jornada: $300 al mes, 10 incluidos.', fuente_url: 'https://vigifield.com/llms.txt', con_llave: false } }) });
    if (u.pathname === '/api/mensajes/enviar') { enviado = r.request().postDataJSON(); return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, mensaje: { id: 'nuevo' } }) }); }
    if (u.pathname.startsWith('/api/mensajes') && !rutas[u.pathname] && !u.pathname.endsWith('/conteos')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, mensajes, hay_mas: false }) });
    if (rutas[u.pathname]) return r.fulfill({ contentType: 'application/json', body: JSON.stringify(rutas[u.pathname]) });
    if (u.pathname === '/logo.svg') return r.fulfill({ contentType: 'image/svg+xml', body: readFileSync(join(aqui, '..', 'src', 'marca', 'fsmail.svg'), 'utf8') });
    if (u.hostname.includes('fonts.g')) return r.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return r.fulfill({ status: 404, body: '' });
  });
  const errores = []; p.on('pageerror', (e) => errores.push(String(e)));
  await p.goto('https://fsmail.test/'); await p.waitForTimeout(900);
  if (nombre === 'escritorio') {
    await p.click('.fila[data-id="m0"]'); await p.waitForTimeout(900);
    await p.screenshot({ path: `${salida}/escritorio.png` });
    // La respuesta sugerida llega a la caja de responder, con su aviso.
    const sug = await p.locator('#r-sug .sug').count(), prellenado = await p.locator('#r-texto').inputValue();
    resultados.push({ vista: 'asistente-sugerencia', errores: sug === 1 && prellenado.includes('$300') ? [] : [`sug=${sug} texto=${prellenado.slice(0, 40)}`] });
    console.log(JSON.stringify(resultados.at(-1)));
    await p.locator('.responder').screenshot({ path: `${salida}/asistente-sugerencia.png` });
    await p.click('#r-enviar'); await p.waitForTimeout(500);
    resultados.push({ vista: 'asistente-usada', errores: usada && enviado?.texto?.includes('$300') ? [] : [`usada=${usada}`] });
    console.log(JSON.stringify(resultados.at(-1))); enviado = null;
    await p.click('[data-config="d2"]'); await p.waitForTimeout(300);
    await p.click('[data-asis="b1"]'); await p.waitForTimeout(400);
    const conf = await p.locator('#as-con').inputValue();
    resultados.push({ vista: 'asistente-config', errores: conf.includes('Plan Jornada') && (await p.locator('#as-activo').isChecked()) ? [] : ['diálogo sin datos'] });
    console.log(JSON.stringify(resultados.at(-1)));
    await p.screenshot({ path: `${salida}/asistente-config.png` });
    await p.click('#as-cancelar'); await p.waitForTimeout(200); await p.keyboard.press('Escape');
    await p.evaluate(() => document.querySelectorAll('.velo').forEach((x) => x.remove()));
    await p.click('.fila[data-id="m0"]'); await p.waitForTimeout(700);
    // El cuerpo HTML debe medir su altura desde adentro del iframe (postMessage), no quedarse en los 150 px por defecto.
    const altoIframe = await p.locator('#lector iframe').evaluate((f) => f.getBoundingClientRect().height);
    resultados.push({ vista: 'iframe', errores: altoIframe > 160 ? [] : [`iframe sin medir: ${altoIframe}px`], alto: altoIframe });
    console.log(JSON.stringify(resultados.at(-1)));
    // Acordeón: abrir vigifield a medio camino para ver el despliegue.
    await p.click('.nodo.dom[data-dom="d2"]'); await p.waitForTimeout(120);
    await p.screenshot({ path: `${salida}/acordeon-medio.png`, clip: { x: 0, y: 0, width: 330, height: 620 } });
    await p.waitForTimeout(400);
    // Redactar con adjuntos.
    await p.click('#btn-redactar'); await p.waitForTimeout(400);
    const tmp = join(salida, 'nota.txt'); writeFileSync(tmp, 'hola, soy un archivo');
    await p.setInputFiles('.dialogo input[type=file]', [tmp, join(aqui, '..', 'package.json')]);
    await p.waitForTimeout(300);
    await p.fill('#r-para', 'cliente@correo.com'); await p.fill('#r-asunto', 'Cotización'); await p.fill('.dialogo #r-texto', 'Van los archivos.');
    await p.screenshot({ path: `${salida}/redactar.png` });
    await p.click('#r-enviar2'); await p.waitForTimeout(500);
  }
  if (nombre === 'movil') {
    await p.screenshot({ path: `${salida}/movil.png` });
    await p.click('.nodo.dir[data-dir="a1"]'); await p.waitForTimeout(500); await p.screenshot({ path: `${salida}/movil-lista.png` });
    await p.click('.fila[data-id="m0"]'); await p.waitForTimeout(700); await p.screenshot({ path: `${salida}/movil-lector.png` });
    // Nada debe desbordar a lo ancho en el celular.
    const ancho = await p.evaluate(() => Math.max(document.documentElement.scrollWidth, document.querySelector('#lector').scrollWidth));
    resultados.push({ vista: 'movil-ancho', errores: ancho <= 390 ? [] : [`desborda: ${ancho}px`], ancho });
    console.log(JSON.stringify(resultados.at(-1)));
    // Un correo «sin dirección» también se puede responder: caja con selector de «desde».
    await p.click('#volver'); await p.waitForTimeout(300);
    await p.click('.fila[data-id="m2"]'); await p.waitForTimeout(700);
    const caja = await p.locator('.responder').count(), selector = await p.locator('#r-desde option').count();
    resultados.push({ vista: 'movil-responder-sin-direccion', errores: caja === 1 && selector === 2 ? [] : [`caja=${caja} opciones=${selector}`] });
    console.log(JSON.stringify(resultados.at(-1)));
    await p.screenshot({ path: `${salida}/movil-responder.png`, fullPage: true });
  }
  const r = { vista: nombre, errores, filas: await p.locator('.fila').count(), nodos: await p.locator('.nodo').count() };
  resultados.push(r); console.log(JSON.stringify(r));
  await p.close();
}
await b.close();
console.log('enviado con adjuntos:', enviado ? `${(enviado.adjuntos || []).length} (${(enviado.adjuntos || []).map((a) => a.nombre).join(', ')})` : 'no');
const falla = resultados.some((r) => r.errores.length) || !enviado || (enviado.adjuntos || []).length !== 2;
if (falla) { console.log('::error::interfaz: hay errores de página o el envío no llevó los 2 adjuntos'); process.exit(1); }
console.log(`capturas en ${salida}`);
