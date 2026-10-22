import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env } from '../src/entorno';

const e = env as unknown as Env & { MIGRACIONES_D1: D1Migration[] };
await applyD1Migrations(e.DB, e.MIGRACIONES_D1);
