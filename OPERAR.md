# Cómo opera un chat en FSMAIL

FSMAIL es un producto aparte. Este archivo es su contrato de trabajo; es
deliberadamente corto. La regla de fondo: **Mike decide, el chat ejecuta y
mide.** Si un chat le pide a Mike que abra GitHub, que haga merge o que le
diga si quedó bien, ese chat no leyó esto.

## 0. Cómo se le pregunta a Mike

Una sola pregunta por vez, con botones (`AskUserQuestion`), cada opción dice
qué implica, la recomendada va primera marcada `(Recomendado)`, y la
consecuencia se dice antes de que decida. Toda respuesta queda escrita en
`claude/CONTINUAR.md` con la fecha. Lo que el chat puede medir, no se
pregunta.

## 1. Arranque

```bash
git push --dry-run origin HEAD:refs/heads/claude/prueba-de-acceso
```

Si pasa, tú publicas. Si falla con 403 o «not in this session's authorized
repository set», es la sesión: dile a Mike el mensaje exacto y para. No
busques tokens en archivos.

## 2. Lo primero que se mira

```bash
git log --oneline -5
curl -s "https://api.github.com/repos/mikebalcazar/fsmail/actions/runs?per_page=3" \
  | python3 -c "import json,sys; [print(r['name'], r['status'], r['conclusion'], r['head_branch']) for r in json.load(sys.stdin)['workflow_runs']]"
```

Si el último run no está verde, eso va primero.

## 3. Un cambio

1. Rama `claude/<lo-que-hace>`.
2. Medir antes de empujar: `npx tsc --noEmit` y `npx vitest run` (corren
   dentro de workerd con D1 y R2 de verdad; Resend es de mentira, ver
   `pruebas/ayuda.ts`). Lo que toque la interfaz se mide contando elementos,
   no mirando capturas.
3. Commit en español: qué, por qué y cómo se probó. Sin identificadores de
   modelo. Siempre con `git commit -F -` y heredoc entre comillas simples.
4. PR y merge a `main` por API, desde el chat.
5. Leer el run del merge (`verificar` deja un comentario en el commit con lo
   que midió) y contarle a Mike qué se midió, con números.

## 4. Qué alcanza el chat

El proxy de la sesión alcanza `api.github.com`, `*.workers.dev` y
`mailing.forespot.com`; se mide con un `curl`, no se supone. Lo que la
sesión no alcance se mide en el runner de Actions, que tiene internet
abierto, y vuelve como comentario del commit. El log de Actions no es el
canal: el proxy no deja bajarlo.

## 5. Lo que es de Mike

Secretos del repositorio (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`), el webhook en el panel de Resend,
y todo lo que sea una consola de administración (crear repositorios, zonas,
cuentas). El chat no lee ni lista secretos: se comprueban porque el deploy
sale verde y `/salud` contesta.

## 6. Lo que un chat NO hace nunca

- Pedirle a Mike que abra GitHub, haga merge o verifique un despliegue.
- Leer, escribir o listar secretos.
- Mandar correo de verdad desde pruebas: fuera de producción el código viaja
  en la respuesta y Resend no se llama.
- Tocar los nombres de infraestructura (`fsmail`, `fsmail-correo`,
  `mailing.forespot.com`): renombrarlos desliga lo que ya vive.
- Meterle a FSMAIL cosas de suite101 (puerta, zona, usuarios, `/s101`).
- Rodear el proxy.
- Preguntarle a Mike dos cosas a la vez o sin botones.
