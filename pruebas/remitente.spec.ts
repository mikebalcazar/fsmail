import { describe, expect, it } from 'vitest';
// El plan de registros es lógica pura; se prueba aquí aunque el script corra en el runner.
// @ts-expect-error módulo JS sin tipos
import { doblados, nombreCompleto, plan } from '../scripts/remitente.mjs';

const DOM = 'mailing.forespot.com';
const ZONA = 'forespot.com';
const pedidos = [
  // Tal como los devolvió Resend el 22-oct-2026 para mailing.forespot.com: relativos a la zona.
  { record: 'DKIM', name: 'resend._domainkey.mailing', type: 'TXT', value: 'p=MIIB' },
  { record: 'SPF', name: 'send.mailing', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
  { record: 'SPF', name: 'send.mailing', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' },
];

describe('remitente: el plan de DNS', () => {
  it('completa los nombres relativos a la ZONA, como los da Resend, sin doblar el dominio', () => {
    expect(nombreCompleto('send.mailing', ZONA)).toBe('send.mailing.forespot.com');
    expect(nombreCompleto('resend._domainkey.mailing', ZONA)).toBe('resend._domainkey.mailing.forespot.com');
    expect(nombreCompleto('send.mailing.forespot.com', ZONA)).toBe('send.mailing.forespot.com');
    expect(nombreCompleto('@', ZONA)).toBe(ZONA);
  });
  it('reconoce los registros doblados del primer run y nada más', () => {
    const ex = [
      { id: '1', type: 'TXT', name: 'resend._domainkey.mailing.mailing.forespot.com', content: 'p=…' },
      { id: '2', type: 'MX', name: 'send.mailing.mailing.forespot.com', content: 'x' },
      { id: '3', type: 'CNAME', name: 'rsend.mailing.mailing.forespot.com', content: 'y' },
      { id: '4', type: 'TXT', name: 'send.mailing.forespot.com', content: 'bien' },
      { id: '5', type: 'A', name: 'mailing.forespot.com', content: '1.2.3.4' },
    ];
    expect(doblados(ex, DOM).map((e: any) => e.id)).toEqual(['1', '2', '3']);
  });
  it('con la zona vacía crea los tres, DNS only y con prioridad en el MX', () => {
    const p = plan(pedidos, [], ZONA);
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
    const p = plan(pedidos, existentes, ZONA);
    expect(p.map((a: any) => [a.accion, a.id])).toEqual([['igual', undefined], ['corregir', '3'], ['corregir', '2']]);
  });
  it('un TXT ajeno en el mismo nombre no se pisa: se crea al lado', () => {
    const p = plan([pedidos[2]], [{ id: '9', type: 'TXT', name: 'send.mailing.forespot.com', content: 'google-site-verification=x' }], ZONA);
    expect(p[0].accion).toBe('crear');
  });
});
