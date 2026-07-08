# Diseño — Tests E2E con Playwright

> Documento de decisiones. La mecánica por tarea va en los planes de
> implementación (`docs/superpowers/plans/2026-07-08-e2e-*`).

## Objetivo

Cobertura end-to-end en navegador real (Chromium) de la webmail Céfiro,
sobre la app **servida como en producción** (el server Hono sirve
`apps/web/dist` como estáticos en `:8080`), corriendo en un job de CI aparte.

## Decisiones

1. **Backend de correo = contenedor Stalwart CE efímero, NO un fake JMAP, NO
   el Stalwart de producción.** Un fake JMAP codifica nuestras suposiciones y
   da falsa confianza ("mock que miente"); el Stalwart de producción no se
   toca (los E2E mutan correo). El contenedor efímero da semántica JMAP real,
   aislada y determinista — mismo patrón que el Postgres que ya levantamos.
   Se introduce en el **slice 2**; el slice 1 no lo necesita.

2. **Slice 1 (esta primera tanda): flujos que NO dependen del correo.** Login
   (pantalla bootstrap vs SSO), shell/header, toggle de tema con persistencia,
   menú de perfil, navegación a ajustes/admin, redirección de rutas inválidas,
   overlay de atajos, sin scroll horizontal en anchos chicos. Verde en CI de
   inmediato, cubre toda la piel de Céfiro, sin infra de correo.

3. **Slice 2: contenedor Stalwart CE + flujos de correo reales** (lista, leer,
   redactar/enviar, destacar, archivar, etiquetas). Requiere provisioning
   headless de un usuario de prueba en Stalwart (a investigar antes de
   planificar). El mismo contenedor puede encender el correo en el dev
   container (hoy "servidor no configurado").

4. **Autenticación en E2E = sesión sembrada (patrón `storageState`), no
   bootstrap.** El `globalSetup` conecta al Postgres de test, crea un usuario
   admin de prueba y una sesión vía el session store, y guarda la cookie en
   `storageState`. La mayoría de specs arrancan autenticadas; el spec de login
   usa un contexto limpio para probar la pantalla sin loguearse. **Cero cambios
   en el código de producción** (no se expone ni fija la contraseña de
   bootstrap).

5. **Ubicación = workspace `e2e/` de nivel superior**, separado de los tests
   Vitest. Su script es `test:e2e` (NO `test`), para que el job unitario
   existente (`bun run --filter '*' test`) lo ignore. Job de CI `e2e` aparte,
   en paralelo al `test` actual.

6. **Egress**: no aplica. Los E2E corren en CI (con internet), no en el
   runtime de producción. El binario de Chromium se instala en CI, igual que
   ya se hornean dependencias en CI.

## Objetivo de ejecución (ambos slices)

`playwright.config.ts` con `webServer` que construye el web (`vite build`) y
levanta el server Hono sirviendo `apps/web/dist` en un puerto de test; los
tests corren headless contra ese `baseURL`. `DATABASE_URL` desde entorno
(fallback dev `:5434`, CI `:5432`). `globalSetup` corre migraciones + siembra.

## Descomposición

- **Plan 1 — Infra + flujos sin correo** (este): workspace e2e, config,
  globalSetup con sesión sembrada, specs de auth/shell/tema/navegación/
  atajos/responsive, job de CI `e2e`.
- **Plan 2 — Stalwart efímero + flujos de correo**: contenedor Stalwart CE en
  el stack de test, provisioning del usuario, specs de correo.
