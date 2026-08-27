# Céfiro — Webmail corporativo

Cliente de correo corporativo (JMAP) de la plataforma Argos. SPA en React
servida por un BFF en Bun que centraliza sesiones, proxy JMAP autenticado y
administración: el navegador nunca habla directo con Stalwart, Authentik ni
Odoo.

## Stack

| Capa | Tecnología |
|------|-----------|
| Frontend | React + Vite (SPA, TypeScript) |
| Backend (BFF) | Bun + Hono + TypeScript |
| Base de datos | PostgreSQL |
| Correo | Stalwart (JMAP) |
| Identidad / SSO | Authentik (OIDC) |

## Estructura del monorepo

```
apps/web         # SPA React + Vite
apps/server      # BFF: API, sesiones, proxy JMAP, admin
packages/shared  # Contratos y clientes API compartidos
e2e              # Suite Playwright (usa docker-compose.e2e.yml)
docs             # ARCHITECTURE.md, DEVELOPMENT.md, design/
```

## Desarrollo

Todo corre aislado en Docker; un solo comando levanta Postgres, la API con
recarga y el frontend con HMR:

```bash
docker compose -f docker-compose.dev.yml up dev
```

| Servicio | URL |
|----------|-----|
| Frontend (Vite, HMR) | http://localhost:5173 |
| API (BFF) | http://localhost:8090/api/health |
| PostgreSQL | localhost:5434 |

Tests y typecheck dentro del contenedor:

```bash
docker compose -f docker-compose.dev.yml exec dev bun run test
docker compose -f docker-compose.dev.yml exec dev bun run typecheck
```

Guía completa (bootstrap, migraciones, hot reload): [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
Arquitectura y principios de diseño: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Runbook de producción (desplegar, revertir, diagnosticar, backups y alertas):
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Configuración

Copiar `.env.example` a `.env` (nunca se commitea). La clave maestra de
cifrado se genera con:

```bash
bun apps/server/scripts/generate-master-key.ts
```

`BOOTSTRAP_MODE=true` solo para el primer arranque o recuperación; en
producción debe ser `false`. Con el modo activo hace falta además
`BOOTSTRAP_PASSWORD` (mínimo 24 caracteres, `openssl rand -base64 24`): es la
credencial de emergencia, la fija quien despliega y el servidor no la registra
en el log.

## Imagen de producción

Build multi-stage (`oven/bun:1.3` → `1.3-slim`), usuario no root, expone 8080:

```bash
docker build -t ghcr.io/noxvytop/cefiro-webmail:<version> .
```

CI publica en GHCR, en cada release, una etiqueta móvil **más** una inmutable:

| Origen | Etiquetas |
|---|---|
| push a `preproduc` | `:staging` + `:sha-<commit>` |
| push a `main` | `:latest` + `:sha-<commit>` |
| tag `vX.Y.Z` | `:vX.Y.Z` + `:latest` + `:sha-<commit>` |

El despliegue vive en [NoxvyTop/docker-cefiro](https://github.com/NoxvyTop/docker-cefiro).
Para producción, **pinnear a `:sha-<commit>` o a `:vX.Y.Z`** (no a `:latest`), de
modo que el rollback sea volver a una imagen exacta anterior.
