# Arquitectura — NoxvyTop Webmail

> Documento vivo. Se actualiza a medida que el diseño evoluciona.

## Vista general

```
┌─────────────┐        ┌──────────────────────────────┐
│  Navegador   │  HTTPS │   BFF (Bun + Hono + TS)      │
│  React SPA   │───────▶│                              │
│              │  SSE   │  - Sesiones (cookie httpOnly)│
└─────────────┘        │  - Proxy JMAP autenticado    │
                        │  - API admin / preferencias  │
                        │  - Puente de notificaciones  │
                        └──┬──────┬──────┬──────┬─────┘
                           │      │      │      │
                    JMAP   │ OIDC │ API  │ XML- │  SQL
                           ▼      ▼ admin▼ RPC  ▼
                      ┌────────┐ ┌────────┐ ┌───────┐ ┌──────────┐
                      │Stalwart│ │Authentik│ │Odoo 17│ │PostgreSQL│
                      └────────┘ └────────┘ └───────┘ └──────────┘
```

## Stack

| Capa | Tecnología |
|------|-----------|
| Frontend | React + Vite (SPA, TypeScript) |
| Backend (BFF) | Bun + Hono + TypeScript |
| Base de datos propia | PostgreSQL |
| Correo | Stalwart (protocolo JMAP) |
| Identidad / SSO | Authentik (OIDC) |
| Suite de organización | Odoo 17 (integración por fases) |

## Principios de diseño

1. **El navegador nunca habla directo con Stalwart, Authentik ni Odoo.**
   Todo pasa por el BFF. La credencial del buzón (segunda contraseña, que el
   empleado no conoce) vive únicamente en el servidor. Cero secretos en el
   frontend.

2. **El BFF es delgado a propósito.**
   Para el correo es esencialmente un proxy JMAP con sesión: recibe la
   petición del SPA, adjunta la credencial del buzón y la reenvía a Stalwart.
   No se duplica la lógica de correo que Stalwart ya resuelve. El BFF solo
   contiene lógica propia donde aporta valor: provisioning, preferencias e
   integración con Odoo.

3. **PostgreSQL guarda solo datos propios de la aplicación**:
   firmas, preferencias de usuario, configuración del administrador y mapeos
   con Odoo. Los correos, carpetas y etiquetas viven en Stalwart — nunca se
   duplican en la base propia. Una sola fuente de verdad por dato.

4. **Notificaciones sin polling.**
   Stalwart empuja eventos JMAP al BFF, y el BFF los reenvía al navegador por
   SSE (Server-Sent Events).

5. **Monorepo con contratos compartidos.**
   `apps/web` (SPA), `apps/server` (BFF), `packages/shared` (tipos y
   contratos). Frontend y backend comparten los mismos tipos TypeScript, por
   lo que no pueden desincronizarse.

6. **Backend runtime-agnostic.**
   Hono + Web APIs estándar; ninguna API exclusiva de Bun en la lógica de
   negocio. Migrar de Bun a Node debe seguir siendo barato.

## Modelo de autenticación

Dos credenciales por empleado:

- **Contraseña Authentik**: la única que el empleado conoce. Login al webmail
  vía SSO (OIDC).
- **Contraseña del buzón Stalwart**: gestionada por el sistema. El empleado
  nunca la ve ni la usa.

El alta de empleados la realiza únicamente el administrador desde el portal
de administración: con nombre, correo y contraseña se provisiona la cuenta en
Authentik (grupo correspondiente) y el buzón en Stalwart. El empleado inicia
sesión con SSO y accede directamente a su bandeja.

### Flujo de login (OIDC)

1. El empleado abre el webmail y pulsa "Iniciar sesión" → redirección a
   Authentik (Authorization Code + PKCE).
2. Se autentica en Authentik con su contraseña.
3. Authentik entrega al BFF los tokens OIDC (ID, access, refresh) con la
   identidad verificada (email).
4. El BFF crea una sesión propia y entrega al navegador una cookie
   `httpOnly` + `Secure` + `SameSite`, opaca (solo identifica la sesión).

### Dónde vive cada credencial

| Credencial | Dónde vive | Llega al navegador |
|------------|-----------|--------------------|
| Cookie de sesión del webmail | Navegador (httpOnly) | Sí (opaca) |
| Tokens OIDC de Authentik | Solo en el BFF | Nunca |
| Contraseña del buzón Stalwart | PostgreSQL, cifrada | Nunca |

Cada aplicación conectada a Authentik (webmail, Odoo, etc.) es un cliente
OIDC independiente con su propio `client_id`/`client_secret`; los tokens de
una aplicación no sirven para otra. El SSO entre aplicaciones lo mantiene
Authentik con su propia cookie en su dominio.

### Puente SSO → buzón

La contraseña del buzón se guarda cifrada (AES-256-GCM) en PostgreSQL. La
clave maestra de cifrado vive fuera de la base, en el secreto de entorno del
contenedor. Al iniciar sesión por SSO, el BFF localiza la credencial por
email, la descifra solo en memoria para esa sesión y con ella se autentica
ante Stalwart vía JMAP.

Reglas no negociables:

- La clave maestra nunca se almacena en la base de datos ni en el repositorio.
- Las credenciales nunca aparecen en logs.
- El descifrado es por sesión y solo en memoria.
- TLS en todo el trayecto BFF ↔ Stalwart.

### Modo bootstrap

Primer arranque al estilo Stalwart: con `BOOTSTRAP_MODE=true` en el entorno,
la aplicación inicia en modo configuración e imprime en consola un usuario
administrador temporal con contraseña generada. Con esa cuenta se configura
el administrador real y se cargan las credenciales de buzón iniciales desde
una pantalla mínima de setup. Al volver el entorno a producción y reiniciar,
el modo configuración desaparece. Esa pantalla de setup es la semilla del
portal de administración de la Fase 2.

## Frontend

Layout de tres paneles: barra lateral (carpetas, etiquetas y zona de
módulos), lista de mensajes con scroll virtual y panel de lectura. La zona de
módulos de la barra lateral prepara el caparazón para los módulos de Odoo
(calendario, tareas) sin tocar el núcleo de correo.

Organización por features (Screaming Architecture):

```
apps/web/src/
├── features/
│   ├── mailbox/     # lista, hilo, carpetas, etiquetas
│   ├── composer/    # redactar, adjuntos, firmas
│   ├── search/
│   ├── auth/        # login SSO, sesión
│   ├── settings/    # firmas, notificaciones, preferencias
│   └── setup/       # pantalla de bootstrap/admin mínimo
├── shared/          # componentes UI base, hooks, utilidades
└── app/             # shell, router, providers
```

Cada feature es autocontenida; dentro se aplica el patrón
container/presentational.

Piezas técnicas:

| Pieza | Elección | Motivo |
|-------|----------|--------|
| Estado de servidor | TanStack Query | Caché, invalidación por SSE, updates optimistas |
| Lista de mensajes | Scroll virtual | Fluidez con buzones de miles de correos |
| Editor de redacción | TipTap | Rich text mantenido y extensible |
| Sistema de diseño | Tailwind CSS + Radix UI | Accesibilidad de base, tema claro/oscuro |
| Notificaciones | SSE + Notification API | Aviso instantáneo sin polling |
| Internacionalización | i18n desde el inicio | Textos en archivos de traducción; habilita funcionalidades futuras por idioma |

## Fases de entrega

| Fase | Alcance |
|------|---------|
| F1 — Correo | Leer, redactar, responder, adjuntos, carpetas, búsqueda, firmas, etiquetas, notificaciones, papelera con retención, login SSO |
| F2 — Administración | Portal admin (alta → provisiona Authentik + Stalwart), grupos de correo, aviso de correo de grupo con activación/desactivación de recepción |
| F3 — Organización | Filtros/reglas (UI de Sieve), respuestas automáticas |
| F4 — Suite Odoo | Calendario embebido, módulo de tareas, configurables por el admin |

Cada fase llega a `main` funcionando.

## Flujo de ramas

`init-desarollo` (desarrollo) → `preproduc` (testing) → `main` (producción).
