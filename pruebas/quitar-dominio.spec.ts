import { describe, expect, it } from 'vitest';
// Qué registros DNS se llevan al quitar un dominio es lógica pura; se prueba aquí.
// @ts-expect-error módulo JS sin tipos
import { registrosDeResend } from '../scripts/quitar-dominio.mjs';

const DOM = 'pruebas.forespot.com';

describe('quitar-dominio: los registros DNS que se van', () => {
  it('se lleva sólo lo de Resend del dominio y respeta DMARC, la raíz de la zona y lo ajeno', () => {
    const ex = [
      { id: '1', type: 'MX', name: 'pruebas.forespot.com', content: 'receive.forge.rmta.net', priority: 10 },
      { id: '2', type: 'TXT', name: 'pruebas.forespot.com', content: '"v=spf1 include:amazonses.com ~all"' },
      { id: '3', type: 'TXT', name: 'resend._domainkey.pruebas.forespot.com', content: 'p=MIGf' },
      { id: '4', type: 'MX', name: 'send.pruebas.forespot.com', content: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
      { id: '5', type: 'TXT', name: 'send.pruebas.forespot.com', content: '"v=spf1 include:amazonses.com ~all"' },
      { id: '6', type: 'TXT', name: '_dmarc.pruebas.forespot.com', content: 'v=DMARC1; p=none' },
      { id: '7', type: 'MX', name: 'forespot.com', content: 'aspmx.l.google.com', priority: 1 },
      { id: '8', type: 'TXT', name: 'forespot.com', content: 'v=spf1 include:_spf.google.com ~all' },
      { id: '9', type: 'TXT', name: 'pruebas.forespot.com', content: 'google-site-verification=abc' },
      { id: '10', type: 'A', name: 'pruebas.forespot.com', content: '1.2.3.4' },
      { id: '11', type: 'MX', name: 'pruebas.forespot.com', content: 'mx.otro.com', priority: 20 },
    ];
    expect(registrosDeResend(ex, DOM).map((e: any) => e.id)).toEqual(['1', '2', '3', '4', '5']);
  });
  it('con una zona sin nada del dominio no se lleva nada', () => {
    expect(registrosDeResend([{ id: '1', type: 'MX', name: 'forespot.com', content: 'receive.forge.rmta.net' }], DOM)).toEqual([]);
  });
});
