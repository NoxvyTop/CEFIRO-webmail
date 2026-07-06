# Diseño — Fase 2: Portal de administración

> Documento vivo. Se completa por secciones durante el brainstorming de F2.
> Diseño de alto nivel en `docs/ARCHITECTURE.md`; acá se resuelven las
> mecánicas de integración.

## Alcance de la Fase 2

- Provisioning JIT de usuarios en el primer login SSO.
- Portal de administración (`/admin`): alta/gestión de usuarios (conexión
  Stalwart), archivado con revocación de sesiones, configuración OIDC e
  integraciones.
- Login con doble entrada: SSO (única vía para empleados) + puerta de
  emergencia bootstrap/recuperación.
- Correos grupales (Modelo A): zona en la barra lateral + toggle de vista de
  bandeja unificada por usuario; responder como la persona; enviar como la
  dirección de empresa vía identidades de F1.

Fuera de alcance de F2:

- **Buzones compartidos con credencial + bandeja colaborativa** (Modelo B):
  diferido al issue #13. Se retoma cuando el volumen lo pida.
- Correos de distribución (solo enrutamiento en Stalwart, sin bandeja).
- Creación automática de cuentas/buzones en Stalwart y en Authentik (queda
  gestionado por el admin en cada sistema).

## Decisiones clave (resueltas en brainstorming)

- **Dos contraseñas, deliberado.** Authentik = llave del ecosistema (SSO,
  gestionada en Authentik). Stalwart = credencial del buzón (gestionada por
  el admin en Stalwart, custodiada cifrada por el portal). Se descarta
  apuntar la autenticación de Stalwart a Authentik.
- **El webmail nunca escribe en Authentik.** No se usa la API de
  administración de Authentik; el provisioning es JIT por lectura del token
  OIDC.
- **El webmail no crea buzones en Stalwart.** No se requiere la API de
  administración de Stalwart en F2.

## Sección 1: Provisioning JIT y alta de usuarios

Los usuarios se gestionan en Authentik; el webmail no los crea allí.

### Primer login = provisioning automático

1. El empleado entra por primera vez con el botón SSO.
2. El BFF valida el token OIDC y **crea la fila en `users`** con la identidad
   verificada (email, nombre) — sin credencial de buzón todavía.
3. El panel de correo muestra el estado `mail_credentials_missing` (ya
   existente desde el Plan 3a de F1): *"Tu buzón no está vinculado todavía"*.
   No es un error: es la señal de que falta el paso del admin.

### El admin completa la conexión Stalwart

Desde el portal, el admin ve las filas de usuarios y **llena la credencial
del buzón** (la contraseña que ya creó y administra en Stalwart). El portal
la guarda cifrada (AES-256-GCM, mismo mecanismo que F1). En el próximo
refresco, el empleado ya tiene su correo.

### Alta proactiva (alternativa)

El admin no está obligado a esperar el primer login: puede **crear la fila
por adelantado** escribiendo email + credencial de Stalwart. Cuando el
empleado entra por primera vez, el JIT encuentra la fila existente (por
email) y la reutiliza en vez de crear una nueva. Los dos caminos conviven.

### Regla de reconciliación

El JIT busca por email (normalizado a minúsculas, como en F1). Si existe una
fila para ese email → la reutiliza y actualiza el nombre si cambió. Si no
existe → la crea. Nunca duplica.

## Sección 2: Pantalla de login con doble entrada

Dos formas de entrar, cada una con su propósito.

### Botón "Iniciar sesión con Authentik" (OAuth2/OIDC)

La vía de los empleados, ya construida en F1. La contraseña del empleado se
queda en Authentik y nunca toca el webmail. Es la puerta normal del día a
día.

### Formulario email + contraseña — solo emergencia

Valida contra la **credencial local de bootstrap** (la que la consola
imprime con `BOOTSTRAP_MODE=true`), NO contra Authentik. Nada de ROPC: la
contraseña de Authentik jamás pasa por el BFF. Sirve para dos momentos:

- **Primer arranque**: con el SSO aún sin configurar, se entra con la
  credencial de consola a configurar el proveedor OIDC y dar de alta
  usuarios.
- **Recuperación**: si una config OIDC defectuosa deja a todos afuera, se
  activa el modo bootstrap y se entra por esta puerta a corregirlo.

### El formulario es invisible fuera de bootstrap

El formulario email+contraseña **solo se renderiza cuando el modo bootstrap
está activo**. En operación normal (`BOOTSTRAP_MODE=false`) la pantalla de
login muestra únicamente el botón de Authentik; el formulario no existe en
el DOM — cero superficie de ataque. Le da forma de UI a la puerta de
recuperación que en F1 ya existía como API (`/api/setup`, guardada por el
`x-setup-token`).

## Sección 3: El portal de administración

Crece desde la pantalla de setup de F1 (config OIDC, alta de credenciales,
creación del admin), pero ahora es una sección completa del webmail,
accesible para usuarios con rol `admin` fuera del modo bootstrap. Vive en
`/admin` (bajo `RequireAuth` + chequeo de rol admin).

### Secciones del portal

- **Usuarios** — tabla central. Lista todas las filas de `users` (JIT +
  altas del admin). Por usuario: email, nombre, rol, estado del buzón
  (vinculado / sin vincular / archivado); acciones de vincular/editar la
  conexión Stalwart, cambiar rol, alta proactiva ("Nuevo usuario") y
  archivar/reactivar.
- **Buzones compartidos** (Sección 4): `info@`, `test@`, grupales — su
  credencial Stalwart cifrada + qué usuarios acceden.
- **Grupos de correo** (Sección 5): zona de grupos y bandeja unificada.
- **Configuración** (de F1, integrada): proveedor OIDC (`sso_config`) e
  integraciones (`integrations`, preparada para Odoo en F4).

### Seguridad del portal (no negociable)

- Todas las rutas `/api/admin/*` exigen sesión CON rol `admin`
  (`requireAdmin` compuesto sobre `requireSession`).
- Toda acción del admin se audita (`audit_log`): altas/ediciones de
  usuarios, cambios de credenciales, cambios de rol, cambios de config,
  gestión de buzones compartidos, archivar/reactivar. Nunca se audita el
  contenido de correos.
- El primer admin nace del bootstrap (F1); de ahí en más, un admin promueve
  a otros desde la pestaña Usuarios.

### Baja de empleados — archivado (soft-delete)

En vez de borrar, se **archiva** (`users.active = false`), al estilo Odoo:
conserva la fila, el historial y la auditoría. El flujo operativo completo
lo reparte el admin entre los tres sistemas (Authentik desactivado, Stalwart
con email cambiado, webmail archivado); el portal controla su parte de forma
que no queden huecos:

1. **Revoca todas las sesiones activas al instante.** Desactivar en
   Authentik solo impide logins NUEVOS; no mata la sesión ya emitida (TTL de
   12 h). Archivar borra las filas de `sessions` del usuario → queda afuera
   inmediatamente, sin esperar el TTL.
2. **Archivado = no puede entrar.** Un usuario archivado no obtiene sesión
   aunque aparezca un token válido de Authentik. El JIT del primer login
   **no reactiva** una fila archivada; reactivar es una acción deliberada del
   admin.
3. **Quita el acceso a buzones compartidos** (se saca de las listas de
   delegación).

Caso borde señalado (no se sobre-diseña ahora): si el email liberado se
reutiliza para otro empleado, la fila archivada "es dueña" del email; el
admin resuelve manualmente (renombrar o borrar la archivada).

Requiere una columna nueva: `users.active boolean not null default true`.

## Sección 4: Buzones compartidos delegados — DIFERIDO (issue #13)

> **NO se implementa en F2.** Diferido al issue #13 (Modelo B: buzón
> compartido con credencial + bandeja colaborativa). Se retoma cuando el
> volumen haga que el Modelo A (Sección 5) se quede corto. El diseño se
> conserva acá como referencia para ese momento.

Un buzón compartido (`info@`, `test@`) es una "cuenta extra" que el webmail
muestra a los usuarios autorizados, sin login aparte.

### Gestión desde el portal

- Registrar un buzón: nombre visible ("Info"), dirección
  (`info@noxvytop.com`) y su credencial Stalwart cifrada (misma mecánica que
  la credencial de un usuario).
- Mapear qué usuarios acceden a cada buzón compartido.
- Todo auditado.

### Experiencia del usuario autorizado

- Entra con su SSO normal. En la barra lateral, un **selector de cuenta**
  (estilo "cambiar cuenta" de Gmail): su buzón personal + los compartidos a
  los que accede.
- Al elegir `info@`, el webmail carga ese buzón vía JMAP con la credencial
  compartida (descifrada en memoria para esa petición) — lee, marca, mueve,
  todo lo de F1.
- **Enviar como** `info@`: al componer desde el contexto del buzón
  compartido, el selector "enviar como" incluye la dirección compartida y el
  envío usa esa credencial. Reusa el composer de F1.

### Modelo de datos

| Tabla | Qué guarda |
|-------|-----------|
| `shared_mailboxes` | id, nombre visible, dirección, credencial cifrada (ciphertext+iv+key_version) |
| `shared_mailbox_access` | mapeo buzón compartido ↔ usuario autorizado |

### Autorización server-side (no negociable)

El BFF verifica en CADA petición que la sesión que pide `info@` esté en
`shared_mailbox_access` para ese buzón. Nunca se confía en la elección del
frontend; un usuario no autorizado recibe 403. La autorización vive en el
servidor.

Reusa todo F1: almacén de credenciales cifradas, proxy JMAP, composer con
identidades. Un buzón compartido es, técnicamente, otra credencial de buzón
que varios usuarios pueden usar.

## Sección 5: Correos grupales (Modelo A) — lo que SÍ va en F2

El modelo elegido para las direcciones compartidas de F2. Una dirección
grupal (`soporte@`, `administracion@`, `incidencias@`) es una **lista de
miembros**; Stalwart entrega una copia a la bandeja propia de cada miembro.
No hay buzón aparte ni credencial compartida.

### Recepción — la copia cae en tu bandeja

- La membresía y la entrega a miembros se configuran en **Stalwart** (el
  admin las gestiona ahí; el webmail no escribe en Stalwart).
- Cuando llega un correo a `soporte@`, Stalwart deja una copia en el buzón
  propio de cada miembro. El webmail lo muestra en la bandeja normal del
  usuario — ya funciona con F1, es su propio correo.

### Zona de grupos + toggle de vista

- **Zona de grupos** en la barra lateral: una vista que filtra el correo
  propio del usuario por dirección de destino grupal (JMAP expone a qué
  dirección llegó cada correo — el "recibido en" de F1).
- **Toggle por usuario** (preferencia del webmail en `user_preferences`, no
  toca Stalwart): el correo grupal SIEMPRE llega físicamente; el toggle
  controla solo la VISTA — activado = se muestra mezclado en la bandeja
  principal; desactivado = se muestra solo en la zona de grupos.

### Responder — como la persona (por defecto)

Un correo grupal lo agarra un miembro y responde con **su dirección
personal** (`beto@`). El cliente le sigue escribiendo a Beto directo: un
dueño por conversación. Es el comportamiento por defecto del composer de F1
— cero configuración extra.

### Enviar como la dirección de empresa (identidades F1)

Para las direcciones que deben salir **como la empresa** (`administracion@`,
`incidencias@`): se cubre con el selector "enviar como" de F1 (identidades
JMAP), NO con la maquinaria de buzón compartido (issue #13).

- En Stalwart se configura que los usuarios autorizados puedan enviar desde
  esas direcciones (la función "una contraseña, varias direcciones").
- Stalwart las expone como identidades; el desplegable "De" del composer de
  F1 las ofrece automáticamente. El correo sale como la dirección de
  empresa, usando la credencial propia del usuario.
- **Accountability preservada**: hacia afuera se ve la dirección de empresa;
  la auditoría (`audit_log`) registra qué usuario la envió. Se ganan las dos
  cosas — marca hacia afuera, responsabilidad hacia adentro.

### Dependencia (config de Stalwart, la gestiona el admin)

El "enviar como la empresa" y la entrega a miembros dependen de que Stalwart
esté configurado en consecuencia (aliases/identidades y membresía de grupo).
Es config del admin en Stalwart; el webmail solo consume lo que Stalwart
expone vía JMAP.

### Modelo de datos

Ninguna tabla nueva de correo. Solo una preferencia por usuario en
`user_preferences` para el toggle de vista (ej. clave
`groupMailInMainInbox: boolean` por dirección grupal, o global).

## Sección 6: Modelo de datos consolidado (F2)

Cambios sobre el esquema de F1 (todo aditivo — migración nueva, no rompe
nada existente):

| Cambio | Detalle |
|--------|---------|
| `users.active` | `boolean not null default true` — archivado (soft-delete) |
| `user_preferences` | ya existe (F1); F2 añade la clave del toggle de bandeja unificada de grupos |
| `audit_log` | ya existe (F1); F2 registra las acciones nuevas del portal |
| `sso_config`, `integrations` | ya existen (F1); el portal les da UI completa |

NO se crean tablas de buzón compartido (`shared_mailboxes`,
`shared_mailbox_access`) — eso vive en el issue #13 (diferido). El
provisioning JIT reusa la tabla `users` de F1.

## Sección 7: Manejo de errores

- **Provisioning JIT**: si el token OIDC no trae email verificado → 401 con
  sobre de error tipado; no se crea fila. Si el usuario está archivado →
  login rechazado con clave i18n dedicada (`errors.account_archived`), sin
  crear sesión.
- **Portal admin**: `requireAdmin` → 403 `errors.forbidden` para sesiones
  sin rol admin. Cuerpos inválidos → 400 `errors.invalid_body` (incluido
  JSON malformado, como en F1). Email duplicado en alta proactiva → 409
  `errors.user_exists`.
- **Config de Stalwart faltante**: si una dirección grupal o identidad no
  está expuesta por Stalwart, el webmail no inventa nada — simplemente no
  aparece en el selector/zona. Sin errores ruidosos; el admin lo resuelve en
  Stalwart.
- **Login doble**: credencial de bootstrap inválida → 401
  `errors.unauthorized`; el formulario solo existe en modo bootstrap.

Todos los errores siguen el sobre uniforme de F1 `{ code, message, traceId }`
con `message` como clave i18n.

## Sección 8: Testing

Misma pirámide que F1:

1. **Unitarios**: lógica del portal (reconciliación JIT por email,
   `requireAdmin`, revocación de sesiones al archivar), componentes de
   presentación del portal y la zona de grupos.
2. **Integración** (Postgres real): provisioning JIT crea/reutiliza/rechaza
   filas correctamente; archivar borra sesiones y bloquea reingreso; alta
   proactiva; auditoría de acciones admin.
3. **E2E** (pocos, críticos): flujo de alta del admin, archivado con
   revocación de sesión, toggle de vista de grupos.

Contratos front↔back con Zod en `packages/shared`, como en F1.

## Descomposición en planes de implementación

F2 se entregará en planes acotados, cada uno un PR revisable (como F1):

1. **Portal — base + provisioning JIT**: `requireAdmin`, `users.active`,
   reconciliación JIT en el callback OIDC, endpoints admin de usuarios
   (listar, alta proactiva, cambiar rol, archivar/reactivar con revocación
   de sesiones), auditoría.
2. **Login doble**: formulario de emergencia bootstrap en la pantalla de
   login (solo en modo bootstrap), sobre la API `/api/setup` de F1.
3. **Portal — UI**: pantalla `/admin` (tabla de usuarios, config OIDC e
   integraciones migradas desde la pantalla de setup de F1).
4. **Grupos de correo**: zona de grupos en la barra lateral (filtro por
   dirección de destino), toggle de bandeja unificada en `user_preferences`.

El "enviar como la empresa" NO necesita plan propio — ya funciona con las
identidades de F1 en cuanto Stalwart expone las direcciones.
