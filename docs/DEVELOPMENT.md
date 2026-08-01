# Entorno de desarrollo

## Contenedor de desarrollo (recomendado)

Todo el desarrollo corre aislado en Docker — nada toca los procesos del
host. Un solo comando levanta Postgres, la API con recarga automática y el
frontend con HMR:

```bash
docker compose -f docker-compose.dev.yml up dev
```

El primer arranque instala dependencias dentro del contenedor (1-2 min);
los siguientes usan la caché de volúmenes.

| Servicio | URL en el host |
|----------|----------------|
| Frontend (Vite, HMR) | http://localhost:5173 |
| API (BFF) | http://localhost:8090/api/health |
| PostgreSQL | localhost:5434 (usuario/clave/db: `webmail`) |

## Recarga en caliente

- **Frontend**: Vite HMR con polling activado (`CHOKIDAR_USEPOLLING`) —
  los cambios en `apps/web/src` se reflejan al guardar, sin recargar la
  página.
- **API**: `bun --watch` reinicia el servidor al guardar cambios en
  `apps/server/src`.
- El código se monta desde el host; los `node_modules` viven en volúmenes
  propios del contenedor (Linux), separados de los del host (Windows).

Si la recarga no reacciona (limitación conocida de Docker Desktop con
montajes de Windows), reiniciar solo el servicio:
`docker compose -f docker-compose.dev.yml restart dev`.

## Comandos dentro del contenedor

Tests y typecheck sin tocar el host:

```bash
docker compose -f docker-compose.dev.yml exec dev bun run test
docker compose -f docker-compose.dev.yml exec dev bun run typecheck
docker compose -f docker-compose.dev.yml exec dev sh -c "cd apps/server && bun run migrate"
```

## Puertos del host ocupados en esta máquina

- `8080`: Odoo local — por eso la API se publica en `8090`.
- `5432`: otro Postgres — por eso el de dev se publica en `5434`.

## Modo bootstrap (setup inicial)

El contenedor de desarrollo arranca con `BOOTSTRAP_MODE=true` y la credencial
que `docker-compose.dev.yml` fija en `BOOTSTRAP_PASSWORD`
(`dev-bootstrap-password-not-a-secret`). La contraseña **no** se busca en el
log: desde #235 el servidor no la genera ni la escribe, la pone quien arranca.
El arranque solo avisa de que el modo está activo:

    docker compose -f docker-compose.dev.yml logs dev | grep "bootstrap mode"

Con esa contraseña se entra en http://localhost:5173/setup para configurar
el proveedor OIDC (Authentik) y crear los primeros usuarios con su
contraseña de buzón. En producción `BOOTSTRAP_MODE` debe ser `false`; se
activa solo para el primer arranque o para recuperación, y `BOOTSTRAP_PASSWORD`
es entonces un secreto generado (`openssl rand -base64 24`, mínimo 24
caracteres) que el proceso exige para arrancar.

`/setup` se cierra solo en cuanto el setup está terminado —hay un administrador
activo y SSO configurado—, aunque `BOOTSTRAP_MODE` siga en `true` (#234). En la
base de datos de desarrollo eso llega enseguida: si `/setup` devuelve 404, es
esto. Para volver a abrirlo hay que vaciar la tabla `sso_config` **y reiniciar
el servidor** —el cierre es de un solo sentido mientras el proceso vive— o
partir de una base limpia.

## Desarrollo directo en el host (alternativa)

Sigue funcionando: `docker compose -f docker-compose.dev.yml up -d postgres`,
luego `bun --watch src/index.ts` en `apps/server` (con `DATABASE_URL` del
`.env`) y `bunx vite` en `apps/web`.

## Correo (Stalwart)

La API de correo usa la variable `STALWART_URL` (URL interna del servidor
JMAP). Sin ella, los endpoints de correo responden 503
`mail_not_configured` — útil en desarrollo sin un Stalwart accesible. Los
tests no necesitan Stalwart: usan un cliente JMAP simulado.
