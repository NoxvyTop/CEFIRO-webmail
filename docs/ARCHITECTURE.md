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

### Configuración OIDC administrable

La configuración del proveedor SSO (issuer, client_id, client_secret,
scopes) vive en la base de datos y se edita desde el portal de
administración, no en variables de entorno. Esto permite reconfigurar
Authentik o migrar a otro proveedor OIDC sin tocar código ni redesplegar.
En el entorno solo quedan secretos de infraestructura: clave maestra de
cifrado y conexión a Postgres.

### Modo bootstrap / recuperación

Al estilo Stalwart, `BOOTSTRAP_MODE=true` en el entorno cumple dos roles:

- **Primer arranque**: la aplicación inicia en modo configuración e imprime
  en consola un usuario administrador temporal con contraseña generada. Con
  esa cuenta se configura el administrador real, el proveedor OIDC y las
  credenciales de buzón iniciales desde una pantalla mínima de setup.
- **Recuperación**: si una configuración OIDC defectuosa deja a todos sin
  acceso, se activa el modo, se entra con la credencial temporal de consola,
  se corrige la configuración y se vuelve a producción.

Al volver el entorno a producción y reiniciar, el modo desaparece. La
pantalla de setup es la semilla del portal de administración de la Fase 2.

Alcance del alta en F1: los empleados ya existen en Authentik y en Stalwart
(creados manualmente en cada sistema). La pantalla de setup solo registra el
usuario en la aplicación y su credencial de buzón cifrada. El alta completa
con provisioning automático (Authentik + Stalwart) llega con el portal de
administración en F2.

## Frontend

Layout de tres paneles: barra lateral (carpetas, etiquetas, zona de grupos y
zona de módulos), lista de mensajes con scroll virtual y panel de lectura.
La zona de módulos de la barra lateral prepara el caparazón para los módulos
de Odoo (calendario, tareas) sin tocar el núcleo de correo. La zona de
grupos (F2) muestra los buzones grupales de Stalwart.

### Identidades múltiples (F1)

Un usuario puede tener varias direcciones de correo. Vía identidades JMAP:

- Selector de "enviar como" al redactar y responder.
- Indicador en cada correo recibido de a qué dirección llegó.
- Al responder se preselecciona la identidad que recibió el correo.

### Grupos de correo (F2)

- Zona de grupos en la barra lateral para ver los correos grupales.
- Toggle por usuario "recibir los correos del grupo en mi bandeja
  principal", activable y desactivable.

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

## Backend (BFF)

Módulos por dominio con arquitectura hexagonal liviana: la lógica de negocio
en el centro y los sistemas externos (Stalwart, Authentik, Postgres) detrás
de puertos (interfaces) implementados por adaptadores en `infra/`.

```
apps/server/src/
├── modules/
│   ├── auth/           # flujo OIDC, sesiones
│   ├── mail/           # proxy JMAP, adjuntos (blobs)
│   ├── notifications/  # eventos Stalwart → SSE al navegador
│   ├── credentials/    # cifrado y custodia de credenciales de buzón
│   ├── settings/       # firmas, preferencias
│   └── setup/          # modo bootstrap
├── core/               # tipos de dominio, errores, puertos
└── infra/              # adaptadores: Postgres, cliente Stalwart, cliente Authentik
```

### Modelo de datos propio

Solo datos de la aplicación; el correo vive en Stalwart. Este es el modelo
de F1 — las fases siguientes añaden sus tablas (grupos de correo y
configuración de administración en F2, mapeos con Odoo en F4).

| Tabla | Qué guarda |
|-------|-----------|
| `users` | email, nombre, rol (empleado/admin), idioma preferido |
| `mail_credentials` | credencial del buzón cifrada (ciphertext + nonce + versión de clave) |
| `signatures` | firmas por usuario (varias, una por defecto) |
| `user_preferences` | notificaciones, tema, ajustes de UI |
| `sessions` | sesiones activas (id opaco, expiración) |
| `audit_log` | actor, acción, objetivo, fecha, IP, detalle (JSON) |
| `sso_config` | proveedor OIDC: issuer, client_id, client_secret (cifrado), scopes |

Las sesiones persisten en Postgres (sobreviven reinicios); la credencial
descifrada no se persiste nunca — se re-descifra bajo demanda y se cachea
solo en memoria.

La auditoría cubre eventos de seguridad y administración: logins (éxito y
fallo), altas/bajas/cambios de usuarios, cambios de credenciales, acciones
del portal admin y cambios de configuración. No se audita la lectura de
correos (volumen, privacidad, ruido).

### Flujo típico — abrir la bandeja

1. El SPA pide `GET /api/mail/messages?folder=inbox`.
2. El BFF valida la cookie de sesión y obtiene la credencial del buzón.
3. El BFF ejecuta JMAP contra Stalwart (`Email/query` + `Email/get`
   encadenados en una sola petición HTTP).
4. Respuesta tipada al SPA con los tipos de `packages/shared`.

### Adjuntos

Suben y bajan en streaming a través del BFF hacia el almacenamiento de blobs
de Stalwart: nunca tocan disco propio ni pasan completos por memoria. El BFF
y Stalwart comparten host (red interna de Docker), por lo que el salto extra
es despreciable. Refuerzos: soporte de Range (reanudación y fragmentos) y
cabeceras de caché (los blobs son inmutables).

### Previsualización de documentos

Los documentos imprimibles se visualizan en el navegador sin guardarse en el
ordenador del empleado:

- PDF e imágenes: renderizado nativo del navegador, alimentado por streaming
  con Range.
- Documentos de ofimática (Word, Excel): visor client-side empaquetado en el
  bundle (sin CDNs, por la restricción de egress).

"Sin descargar" significa sin archivo en disco: los bytes se transmiten a la
memoria del navegador para renderizarse.

### Seguridad de adjuntos y contenido

- **El servidor nunca abre ni interpreta archivos**: el BFF solo transmite
  bytes entre Stalwart y el navegador. Un adjunto malicioso no puede
  ejecutarse en el servidor porque nada lo parsea ahí.
- El renderizado ocurre en el sandbox del navegador del empleado.
- **HTML de correos**: sanitizado con DOMPurify y renderizado en iframe
  aislado con CSP estricta (el vector principal en webmails es el HTML del
  correo, no los adjuntos).
- **Antivirus en la entrega**: se recomienda integrar ClamAV en Stalwart
  para escanear los correos al llegar (configuración del servidor de
  correo, fuera de esta aplicación).
- La restricción de egress limita el alcance de cualquier compromiso del
  servidor.

### Papelera con retención

La regla de borrado tras X días la ejecuta Stalwart. En F1 se configura
directamente en Stalwart; desde F2 el plazo se definirá en el portal de
administración vía la API de Stalwart.

## Manejo de errores y observabilidad

- **Errores tipados en el dominio**: los adaptadores traducen cada fallo
  externo (Stalwart caído, Authentik sin respuesta, error JMAP) a un error de
  dominio conocido.
- **Sobre de error uniforme** hacia el SPA: `{ code, message, traceId }`,
  donde `message` es una clave i18n.
- **traceId de punta a punta**: cada petición lleva un identificador que la
  sigue por SPA → BFF → Stalwart y aparece en todos los logs relacionados.
- **Logs estructurados** (JSON), filtrables por usuario, ruta y traceId.
  Ninguna credencial aparece jamás en logs.
- **Frontend resiliente**: reintentos con backoff para fallos transitorios;
  si Stalwart no responde, banner de desconexión manteniendo visible el
  contenido cacheado.
- **Health checks**: endpoint que reporta el estado de Postgres, Stalwart y
  Authentik.

## Testing

1. **Unitarios** (base): dominio del BFF y componentes de presentación
   (Vitest).
2. **Integración**: módulos del BFF contra un Stalwart JMAP simulado y un
   Postgres real de test — cifrado de credenciales, flujo OIDC, proxy JMAP.
3. **E2E** (pocos y críticos): Playwright contra el stack completo en Docker
   — login SSO, leer, redactar, enviar, adjuntar.

`packages/shared` valida los contratos front↔back con Zod: verificación en
compilación y en runtime.

## Despliegue

- Docker Compose en el mismo servidor que Stalwart: un contenedor de
  aplicación (el BFF sirve la API y el SPA estático) + un contenedor
  PostgreSQL, en red interna compartida con Stalwart.
- TLS termina en el reverse proxy existente del servidor.
- **CI (GitHub Actions)**: cada push ejecuta lint + typecheck + tests; merge
  a `preproduc` publica imagen de staging; merge a `main` publica la imagen
  de producción en GHCR y el servidor la actualiza.
- Secretos (clave maestra de cifrado, client secret de Authentik) por
  variables de entorno del servidor — nunca en el repositorio ni en la
  imagen.

### Restricción de egress (regla de diseño)

Preproducción y producción operan con egress restringido: la conexión
permitida es hacia GitHub/GHCR (repos e imágenes propios).

- **La aplicación en runtime no realiza ninguna petición a internet.**
- Fuentes autoalojadas (woff2 dentro del bundle, vía paquetes npm), sin CDNs
  de ningún tipo; iconos y librerías empaquetados en build.
- Las dependencias se resuelven en CI (build), quedan horneadas en la imagen
  y fijadas por lockfile (`bun.lock`) para builds reproducibles.
- Las imágenes remotas dentro de correos HTML las carga el navegador del
  empleado (no el servidor) y se bloquean por defecto con botón
  "cargar imágenes" (anti-tracking).

## Fases de entrega

| Fase | Alcance |
|------|---------|
| F1 — Correo | Leer, redactar, responder, adjuntos con previsualización, carpetas, búsqueda, firmas, etiquetas, identidades múltiples (enviar como / recibido en), notificaciones, papelera con retención, login SSO, bootstrap/recuperación |
| F2 — Administración | Portal admin (alta → provisiona Authentik + Stalwart, configuración OIDC), zona de grupos de correo, aviso de correo de grupo con activación/desactivación de recepción en bandeja principal |
| F3 — Organización | Filtros/reglas (UI de Sieve), respuestas automáticas |
| F4 — Suite Odoo | Calendario embebido, módulo de tareas, configurables por el admin |

Cada fase llega a `main` funcionando.

## Flujo de ramas

`init-desarollo` (desarrollo) → `preproduc` (testing) → `main` (producción).
