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
