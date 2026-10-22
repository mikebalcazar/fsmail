import { describe, expect, it } from 'vitest';
// El plan de registros es lógica pura; se prueba aquí aunque el script corra en el runner.
// @ts-expect-error módulo JS sin tipos
import { nombreCompleto, plan } from '../scripts/remitente.mjs';

const DOM = 'mailing.forespot.com';
const pedidos = [
  { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIIB' },
  { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
  { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' },
];

describe('remitente: el plan de DNS', () => {
  it('completa los nombres como los quiere Cloudflare', () => {
    expect(nombreCompleto('send', DOM)).toBe('send.mailing.forespot.com');
    expect(nombreCompleto('send.mailing.forespot.com', DOM)).toBe('send.mailing.forespot.com');
    expect(nombreCompleto('@', DOM)).toBe(DOM);
  });
  it('con la zona vacía crea los tres, DNS only y con prioridad en el MX', () => {
    const p = plan(pedidos, [], DOM);
    expect(p.map((a: any) => a.accion)).toEqual(['crear', 'crear', 'crear']);
    expect(p[1].deseado).toEqual({ type: 'MX', name: 'send.mailing.forespot.com', content: 'feedback-smtp.us-east-1.amazonses.com', ttl: 1, proxied: false, priority: 10 });
    expect(p[0].deseado.proxied).toBe(false);
  });
  it('lo que ya está igual no se toca; un SPF distinto se corrige; un MX con otro valor se corrige', () => {
    const existentes = [
      { id: '1', type: 'TXT', name: 'resend._domainkey.mailing.forespot.com', content: '"p=MIIB"' },
      { id: '2', type: 'TXT', name: 'send.mailing.forespot.com', content: 'v=spf1 include:viejo.com ~all' },
      { id: '3', type: 'MX', name: 'send.mailing.forespot.com', content: 'otro.servidor.com', priority: 10 },
      { id: '4', type: 'TXT', name: 'mailing.forespot.com', content: 'algo-ajeno' },
    ];
    const p = plan(pedidos, existentes, DOM);
    expect(p.map((a: any) => [a.accion, a.id])).toEqual([['igual', undefined], ['corregir', '3'], ['corregir', '2']]);
  });
  it('un TXT ajeno en el mismo nombre no se pisa: se crea al lado', () => {
    const p = plan([pedidos[2]], [{ id: '9', type: 'TXT', name: 'send.mailing.forespot.com', content: 'google-site-verification=x' }], DOM);
    expect(p[0].accion).toBe('crear');
  });
});
