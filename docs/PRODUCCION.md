# Hoja de ruta a producción

Estado y plan de endurecimiento de CEFIRO-webmail para llevarlo a producción sin
riesgo de mala reputación. Sale de una auditoría de cinco dimensiones con
evidencia `file:line`, sintetizada aquí como punto de partida y objetivo.

## Dónde estamos (auditoría — global ~73%)

El núcleo está bien construido y es seguro. Lo que falta no es el producto: es lo
que lo mantiene en pie en producción y lo que ve un usuario en el teléfono.

| Dimensión | % | Lectura corta |
|---|---|---|
| Seguridad y privacidad | **87%** | Sin hallazgo crítico ni de fuga. Cifrado en reposo con rotación, sesiones hasheadas, correo en iframe sandbox, SQL parametrizado. Los huecos son abuso/coste, no confidencialidad. |
| Testing / CI | **80%** | Tests reales y adversariales, pipeline reproducible. Faltan compuertas de lint y cobertura. |
| Frontend / diseño / a11y | **72%** | Escritorio casi listo, tokens auditados a WCAG. El móvil está roto. |
| Fiabilidad / observabilidad | **72%** | Buen manejo de errores y timeouts HTTP; la base de datos es el eslabón sin proteger. |
| Operaciones / despliegue | **62%** | Config a prueba de balas, cero secretos en el repo; sin backup/DR ni rollback. |

Lo que ya está muy bien y no hay que perder de vista: rotación de `MASTER_KEY`
con guarda de arranque (#172), timeouts salientes (#165), Stalwart caído → 502
(#187), píxel de rastreo por `<style>` cerrado (#182), cabecera de auth
falsificada ignorada (#136), rate limit del login de emergencia (#183). El Sieve
no expone `redirect`/`forward`, así que no hay vector de exfiltración de correo.

## Qué esperamos al finalizar

Cerrar los bloqueadores de operabilidad y móvil sube de ~73% a la franja de los
85-90%, **sin tocar la arquitectura**. El trabajo se agrupa en tres olas, por
orden de impacto en reputación.

### Ola 8 — Operabilidad para lanzar (bloqueadores duros)

No se lanza sin esto.

| Issue | Qué | Por qué duele |
|---|---|---|
| #189 | **Autobackup interno diario de Postgres + restore probado** | Perder `pgdata` = credenciales de correo de todos irrecuperables |
| #190 | Imagen inmutable por SHA/semver + rollback | Hoy solo `:latest`/`:staging`: no hay a qué volver |
| #191 | Acotar Postgres (timeouts + pool) y su caída → 503 | Una query lenta cuelga todo el servicio; caída = 500 "bug nuestro" |
| #192 | Confirmar `EmailSubmission` en el envío | Hoy un fallo parcial invita a reenviar → entrega duplicada |
| #193 | Apagado ordenado (SIGTERM drain + `sql.end`) | Cada deploy corta envíos en vuelo |

### Ola 9 — Abuso, límites y compuertas

Antes de escalar usuarios.

| Issue | Qué |
|---|---|
| #194 | Rate limit en `/login` (amplificación OIDC) + cuota por usuario en IA (coste) |
| #195 | `bodyLimit` global + cap de entrada del resumen de IA |
| #196 | Forzar cookies `Secure`/HTTPS en producción (hoy fail-open por `APP_URL`) |
| #197 | Health check que cubra Stalwart y devuelva 503 degradado (+ `HEALTHCHECK`) |
| #198 | Compuerta de lint (biome) en CI |
| #199 | Medición y umbral de cobertura en CI |

### Ola 10 — Pulido y accesibilidad

| Issue | Qué |
|---|---|
| #200 | A11y del shell: landmark `<main>`, skip link, errores de login anunciados |
| #201 | Code splitting por ruta (Admin/Settings/Setup + editor) |
| #153 | Paginar el listado de usuarios de admin (ya abierto) |

## Backups — SOS de datos (contexto de #189)

Dos capas que se complementan; no dependemos de una sola:

1. **Autobackup interno diario** (dentro del stack de Céfiro): `pg_dump` cifrado,
   una vez al día, con retención y **restauración probada**. Es la red de
   seguridad a nivel aplicación. La clave del backup no vive junto al backup, y
   un backup restaurado debe seguir descifrable con el llavero vigente (#172).
2. **Backup externo por ARGOS** (infraestructura, fuera de este repo): ARGOS hará
   backup de todos los contenedores y los llevará a un bucket **Backblaze B2**.
   Cubre el nivel de infraestructura; el autobackup interno cubre el de datos de
   aplicación. Documentar qué cubre cada uno.

## Estrategia móvil — decisión pendiente (#202, enlaza #177 y #185)

El móvil está roto hoy (#177): la lista de correo se recorta y no hay forma de
llegar a ella. Es un asesino de primera impresión para un producto comercial.

Dos caminos, no excluyentes:

- **A — Responsividad de la web actual** (corto plazo, Ola 10): drawer con
  hamburguesa bajo `lg`. Barato, reutiliza UI y tests, tapa el agujero ya.
- **B — App nativa multiplataforma** (largo plazo, #185): la hipótesis es que una
  app nativa **gana más funcionalidades a nivel global** (push real, cuenta del
  sistema, offline, integración de plataforma). Candidata Flutter; el trade-off
  mayor es reescribir la UI y el editor rico. Análisis completo en #185.

**Recomendación:** arreglar #177 con responsividad ya (no quedar inusables
mientras se decide), y decidir B con calma. Si se va a nativo, la web responsive
sigue de webmail de escritorio y de fallback.

## Conexión Céfiro↔Stalwart (contexto, #188)

Doc de diseño aparte: la conexión es una sola (JMAP sobre `STALWART_URL`; el
navegador nunca toca Stalwart). La topología de contenedores en la misma red
(edge-core) ya funciona; falta la confianza TLS agnóstica del proveedor para
servidores dedicados. Ver #188.

## Fuera de alcance de esta hoja de ruta

La marca/rediseño visual, el backend de Stalwart en sí, y la infraestructura de
ARGOS (que vive en su propio repo). Aquí solo el endurecimiento de Céfiro para
producción.
