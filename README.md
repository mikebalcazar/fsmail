# FSMAIL

Correo para varios dominios bajo un solo usuario. Entras en
**mailing.forespot.com**, agregas los dominios de tus negocios, les creas
direcciones (`ventas@`, `info@`…) y el correo de cada uno llega a su bandeja,
separada por dominio y por dirección. Respondes desde la misma dirección.

- **Worker** de Cloudflare (`src/`): interfaz en `/`, API en `/api`, webhook
  de Resend en `/webhook/resend`.
- **D1** (`migrations/`): cuentas, dominios, direcciones y la ficha de cada
  mensaje. **R2**: el mensaje completo y sus adjuntos.
- **Resend** recibe (MX del negocio) y entrega (API). Es el único proveedor
  externo y va detrás de `src/cartero.ts`.

Arquitectura, decisiones y pendientes: `claude/arquitectura.md`. Cómo se
trabaja aquí: `OPERAR.md`.

```bash
npm ci
npx tsc --noEmit
npx vitest run
```
