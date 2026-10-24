#!/usr/bin/env node
/* El logo de FSMAIL y sus íconos, desde una sola geometría. Decisión de Mike
 * (24-oct-2026, con botones): «Avión de puntos», un avión de papel cuya
 * nariz es un punto de FORESPOT, con la lima #d4ff3b y el negro #0d0e10 de
 * forespot.com. Una sola tinta, para que sirva también de badge monocromo.
 *
 *   node scripts/iconos.mjs        → escribe src/marca/*.svg y src/*.png
 *
 * Necesita Chromium (Playwright): se corre a mano, no en CI. Los PNG se
 * suben al repo porque viajan dentro del Worker. */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const SRC = join(aqui, '..', 'src');
mkdirSync(join(SRC, 'marca'), { recursive: true });
export const LIMA = '#d4ff3b', NEGRO = '#0d0e10';

/** El dibujo en 100×100. `tinta` única; `fondo` opcional (sin fondo = silueta). `pliegue` sombrea el ala interior. */
export function avion({ tinta = LIMA, fondo = NEGRO, pliegue = true, radio = 22, margen = 0 } = {}) {
  const s = 1 - margen * 2, o = margen * 100; // escala para la zona segura de los íconos maskable
  const g = `<g transform="translate(${o} ${o}) scale(${s})">
    <path fill="${tinta}" d="M18 50 80 25 61 80 46 59z"/>
    ${pliegue ? `<path fill="${fondo || '#000'}" opacity=".32" d="M46 59 80 25 61 80z"/>` : ''}
    <circle cx="81" cy="24" r="9.5" fill="${tinta}" stroke="${fondo || 'none'}" stroke-width="${fondo ? 4 : 0}"/>
  </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${fondo ? `<rect width="100" height="100" rx="${radio}" fill="${fondo}"/>` : ''}${g}</svg>`;
}

/** Marca con palabra, para la pantalla de entrada: ícono + FSMAIL en geométrica abierta. */
export function marcaConPalabra({ tinta = '#15171c', acento = LIMA, fondoIcono = NEGRO } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 60"><g transform="translate(0 2) scale(.56)">${avion({ tinta: acento, fondo: fondoIcono }).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g>
    <text x="72" y="41" font-family="Inter,system-ui,sans-serif" font-size="30" font-weight="800" letter-spacing="7" fill="${tinta}">FSMAIL</text></svg>`;
}

const archivos = {
  'marca/fsmail.svg': avion(),
  'marca/fsmail-silueta.svg': avion({ tinta: '#ffffff', fondo: '', pliegue: false }),
  'marca/fsmail-palabra.svg': marcaConPalabra(),
};
for (const [n, c] of Object.entries(archivos)) writeFileSync(join(SRC, n), c);

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const png = async (svg, n, salida, transparente = false) => {
    const p = await b.newPage({ viewport: { width: n, height: n }, deviceScaleFactor: 1 });
    await p.setContent(`<body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${n}" height="${n}" `)}</body>`);
    await p.screenshot({ path: join(SRC, salida), omitBackground: transparente }); await p.close();
    console.log(salida);
  };
  for (const n of [96, 192, 512]) await png(avion(), n, `icono-${n}.png`, true);
  await png(avion({ radio: 0, margen: 0.1 }), 512, 'icono-maskable-512.png');
  await png(avion({ tinta: '#ffffff', fondo: '', pliegue: false }), 96, 'badge-96.png', true);
  await b.close();
}
