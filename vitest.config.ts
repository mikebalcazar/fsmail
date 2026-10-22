import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Las pruebas corren dentro de workerd con el D1 y el R2 de verdad; lo único
// de mentira es Resend (fetchMock). ENTORNO=prueba hace que el código de
// acceso viaje en la respuesta; que en producción NO viaje es otra prueba.
const raiz = path.dirname(fileURLToPath(import.meta.url));
const migraciones = await readD1Migrations(path.join(raiz, 'migrations'));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          MIGRACIONES_D1: migraciones,
          ENTORNO: 'prueba',
          ORIGEN: 'https://fsmail.test',
          RESEND_API_KEY: 're_de_prueba',
          // whsec_ + base64 de una llave cualquiera; lo mismo que daría Resend.
          RESEND_WEBHOOK_SECRET: 'whsec_c2VjcmV0by1kZS1wcnVlYmEtZnNtYWls',
        },
      },
    }),
  ],
  test: { include: ['pruebas/**/*.spec.ts'], setupFiles: ['./pruebas/preparar.ts'], testTimeout: 20000 },
});
