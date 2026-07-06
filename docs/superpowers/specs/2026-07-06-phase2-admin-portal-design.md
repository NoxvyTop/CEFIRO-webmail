# Diseño — Fase 2: Portal de administración

> Documento vivo. Se completa por secciones durante el brainstorming de F2.
> Diseño de alto nivel en `docs/ARCHITECTURE.md`; acá se resuelven las
> mecánicas de integración.

## Alcance de la Fase 2

- Provisioning JIT de usuarios en el primer login SSO.
- Portal de administración: alta/gestión de usuarios (conexión Stalwart),
  grupos de correo, buzones compartidos, configuración OIDC e integraciones.
- Login con doble entrada: SSO (única vía para empleados) + puerta de
  emergencia bootstrap/recuperación.
- Buzones compartidos delegados (funcionales `info@`, `test@`, y grupales):
  selector de cuenta, leer y enviar como.
- Grupos de correo: zona en la barra lateral + vista de bandeja unificada
  opcional por usuario.

Fuera de alcance: correos de distribución (solo enrutamiento en Stalwart,
sin bandeja); creación automática de buzones en Stalwart (queda manual, el
admin la gestiona en Stalwart).

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

## Sección 4: Buzones compartidos delegados

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
