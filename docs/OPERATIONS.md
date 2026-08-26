# Operaciones

Runbook de CEFIRO-webmail: desplegar, revertir, diagnosticar y recuperar. Está
escrito para que un operador que no conoce el código pueda hacer las cuatro
cosas sin preguntarle a nadie.

El **despliegue** (compose, proxy, secretos, red con Stalwart) vive en
[NoxvyTop/docker-cefiro](https://github.com/NoxvyTop/docker-cefiro). Este repo
produce la imagen y documenta cómo operarla; aquel define dónde corre.

| Necesito… | Sección |
|---|---|
| Poner el servicio en marcha por primera vez | [Despliegue](#despliegue) → [Checklist de primer arranque](#checklist-de-primer-arranque) |
| Subir una versión nueva | [Desplegar una versión](#desplegar-una-versión) |
| Pasar `preproduc` a producción y cortar un `vX.Y.Z` | [Promoción y versionado](#promoción-y-versionado) |
| Volver atrás porque algo se rompió | [Revertir (rollback)](#revertir-rollback) |
| Un usuario reporta un error con un identificador | [Diagnóstico](#diagnóstico-triage) → [Correlacionar por `traceId`](#correlacionar-por-traceid) |
| Saber por qué el contenedor sale de rotación | [Qué significa `/api/health` degradado](#qué-significa-apihealth-degradado) |
| Montar métricas y alertas | [Métricas y alertas](#métricas-y-alertas) |
| Restaurar la base de datos | [dbSOS](#dbsos--copia-de-emergencia-de-la-base-de-datos) |
| Rotar la clave maestra | [Rotación de `MASTER_KEY`](#rotación-de-master_key) |
| Estoy en mitad de un incidente | [Camino de incidente](#camino-de-incidente) |

## Despliegue

### La imagen

Un solo contenedor de aplicación: el BFF sirve la API **y** la SPA estática.
Escucha en `PORT` (por defecto `8080`), corre como usuario no root y trae su
propio `HEALTHCHECK` (ver [Dockerfile](../Dockerfile)).

CI publica en GHCR, en cada push, una etiqueta móvil **más** una inmutable:

| Origen | Etiquetas |
|---|---|
| push a `preproduc` | `:staging` + `:sha-<commit>` |
| push a `main` | `:latest` + `:sha-<commit>` |
| tag `vX.Y.Z` | `:vX.Y.Z` + `:latest` + `:sha-<commit>` |

**Producción se pinnea siempre a `:sha-<commit>` o `:vX.Y.Z`, nunca a
`:latest`.** No es una preferencia de estilo: si el despliegue apunta a una
etiqueta móvil, no existe "la versión anterior" a la que volver — revertir sería
adivinar qué había ahí antes.

### Qué garantiza la imagen publicada

Cuatro compuertas, todas antes de publicar (#244, #260):

| Compuerta | Qué asegura |
|---|---|
| **Base fijada por digest** | El `Dockerfile` referencia `oven/bun` por `sha256:`, no por la etiqueta móvil `1.3`. El mismo commit reconstruye la misma imagen; sin esto, `:sha-<commit>` prometía una inmutabilidad que su capa base no tenía. Se refresca a mano, con el comando que hay escrito en el propio `Dockerfile`. |
| **Escaneo de vulnerabilidades** | Trivy sobre la imagen construida. **Bloquea la publicación** ante severidad `HIGH`/`CRITICAL` con parche disponible; lo no parcheable se imprime pero no bloquea, porque una compuerta que hay que saltarse para poder desplegar deja de ser una compuerta. Las excepciones vivas están en [`.trivyignore.yaml`](../.trivyignore.yaml), **cada una con su razón y su fecha de caducidad**: cuando caduca, el hallazgo vuelve a bloquear y hay que volver a mirarlo. Si el pipeline se para ahí, el propio fichero explica los tres pasos. |
| **Prueba de humo** | CI arranca la imagen recién construida contra un Postgres real y no publica hasta que el contenedor se declara sano por su propio `HEALTHCHECK`, `/api/health` responde `status: ok`, la SPA se sirve y los scripts de la dbSOS están dentro y son ejecutables. Antes de esto, la e2e corría la app desde el código fuente: verde no significaba que el artefacto arrancara. |
| **SBOM y procedencia** | Cada publicación adjunta inventario de paquetes y atestación de procedencia (commit, workflow y run que la produjeron). Se consultan sin descargar la imagen: |

```sh
docker buildx imagetools inspect ghcr.io/noxvytop/cefiro-webmail:vX.Y.Z --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/noxvytop/cefiro-webmail:vX.Y.Z --format '{{ json .Provenance }}'
```

**Lo que todavía NO hay: firma de la imagen.** Está pendiente a propósito, no por
olvido: firmar (cosign con la identidad OIDC del workflow) solo aporta algo si
alguien **verifica** la firma antes de arrancar el contenedor, y ese paso vive en
`docker-cefiro`, no aquí. Firmar sin verificar es ceremonia. Cuando se aborde,
son las dos mitades a la vez: `cosign sign` en la publicación y `cosign verify`
como puerta del despliegue.

### Variables de entorno

**Obligatorias.** Sin una de estas el proceso registra `invalid configuration` y
sale con código 1 en el arranque, a propósito: una configuración a medias falla
al desplegar, no a mitad de la jornada.

| Variable | Qué es |
|---|---|
| `DATABASE_URL` | URI de conexión a Postgres. |
| `MASTER_KEY` | Clave maestra de cifrado, base64 de 32 bytes (44 caracteres). Se genera con `bun apps/server/scripts/generate-master-key.ts`. |
| `APP_URL` | URL pública del webmail. Es la base de los `redirect_uri` de OIDC. |

**Arranque y sesión.**

| Variable | Por defecto | Qué hace |
|---|---|---|
| `PORT` | `8080` | Puerto de escucha. Si se cambia, hay que ajustar también el `HEALTHCHECK` del Dockerfile. |
| `NODE_ENV` | `development` | `production` sirve la SPA estática y **fuerza cookies `Secure`** aunque `APP_URL` sea `http://`. En producción va siempre a `production`. |
| `BOOTSTRAP_MODE` | `false` | Modo de primer arranque/recuperación. Ver el checklist. **En operación normal, `false`.** |
| `BOOTSTRAP_PASSWORD` | — | Credencial de emergencia. **Obligatoria si `BOOTSTRAP_MODE=true`** (el proceso no arranca sin ella) e ignorada si no. Mínimo 24 caracteres; se genera con `openssl rand -base64 24`. Es contraseña del login de emergencia **y** token de `/setup`: va en el mismo gestor de secretos que `MASTER_KEY` y se retira al volver a `false`. |
| `SESSION_TTL_HOURS` | `12` | Vida absoluta de la sesión (tope no extensible). |
| `SESSION_IDLE_MINUTES` | — | Timeout por inactividad (sliding, #301). Sin definir = sin límite de inactividad. Si se define, una sesión sin uso durante más de estos minutos caduca antes del tope absoluto. |
| `STATIC_DIR` | `/app/apps/web/dist` | Ya viene fijado en la imagen. |
| `SHUTDOWN_GRACE_MS` | `15000` | Plazo **único y compartido** entre las dos fases acotadas del apagado: parar los trabajos de fondo (#313) y drenar las peticiones en vuelo. Lo que consuma la primera se descuenta de la segunda, con un suelo de 1 s para el drenaje, así que la espera hasta el cierre forzado no supera este valor (antes cada fase corría su propio plazo y podía llegar al doble, más que el kill timeout del orquestador). |
| `SHUTDOWN_DB_TIMEOUT_MS` | `5000` | Plazo para cerrar el pool de Postgres. |

**Correo (proveedor JMAP).** Sin `JMAP_URL` los endpoints de correo responden
`503 mail_not_configured` y el chequeo del proveedor no se ejecuta. Los nombres
son por rol, no por producto (#33): Céfiro es un cliente JMAP (RFC 8620) y
Stalwart es el proveedor que usamos, no una dependencia dura.

| Variable | Por defecto | Qué hace |
|---|---|---|
| `JMAP_URL` | — | URL del proveedor JMAP por el **camino más directo** (red interna, nombre de servicio, link privado). Nunca el borde TLS público: ver [Topologías](#topologías-de-conexión-al-proveedor-jmap-188). |
| `JMAP_URL_MODE` | `rewrite` | Qué hacer con las URLs que el proveedor anuncia en su sesión (`apiUrl`/`uploadUrl`/`downloadUrl`/`eventSourceUrl`). `rewrite` reescribe **solo el origen** al de `JMAP_URL` y conserva ruta, query y los marcadores `{accountId}`/`{blobId}`. `trust` las usa tal cual. No hay `auto`. |
| `JMAP_AUTH_MODE` | `basic` | Cómo se presenta la credencial de buzón: `basic` (HTTP Basic `email:contraseña`, Stalwart y casi todo servidor autoalojado) o `bearer` (`Authorization: Bearer <credencial>`, proveedores con token/OAuth). |
| `JMAP_AUTHSERV_ID` | — | authserv-id (RFC 8601 §5) de **tu** MTA receptor: el primer token de la cabecera `Authentication-Results` que Stalwart añade. Solo se confía en esa cabecera para la tilde de "remitente verificado". Vacío = a prueba de fallos, todos los veredictos en `unknown`. Ver [Autenticidad del remitente](#autenticidad-del-remitente-jmap_authserv_id-152). |
| `JMAP_TIMEOUT_MS` | `10000` | Plazo de las llamadas salientes al proveedor. |
| `SHARED_MAILBOX_COPY_ENABLED` | `true` | Copias automáticas de buzones compartidos (#313): el servidor copia el correo nuevo de un buzón compartido a la bandeja de cada miembro que activó la opción. Activo por defecto porque sin opt-ins no hace nada; solo aplica con `JMAP_URL`. `false` o `0` pausa la entrega sin ocultar la opción; `true` o `1` la activa, igual que dejar la variable sin definir o vacía. Se lee sin distinguir mayúsculas ni espacios alrededor, y **cualquier otra palabra** (`off`, `no`, `disabled`) **aborta el arranque** con un mensaje que la nombra, en vez de dejar la entrega activa en silencio. Ver [Copias automáticas](ARCHITECTURE.md#copias-automáticas-de-buzones-compartidos-313). |
| `SHARED_MAILBOX_COPY_POLL_MS` | `300000` | Cada cuánto el worker sondea cada buzón compartido con opt-ins, como red de seguridad bajo su suscripción EventSource. Un push perdido cuesta como mucho este retraso; el sondeo en sí es un `Email/changes` por buzón. |
| `NODE_EXTRA_CA_CERTS` | — | **No es una perilla de Céfiro**: la respetan Bun y Node. Ruta a un bundle PEM para confiar en un proveedor con certificado privado o CA interna. No existe ningún modo `insecure`. |

**Nombres retirados (#33/#34).** Los viejos siguen funcionando salvo uno, y el
servidor avisa en cada arranque (`deprecated configuration`) hasta que se
renombren:

| Nombre viejo | Estado | Equivalencia |
|---|---|---|
| `STALWART_URL` | Se sigue leyendo, con aviso | `JMAP_URL` |
| `STALWART_TIMEOUT_MS` | Se sigue leyendo, con aviso | `JMAP_TIMEOUT_MS` |
| `JMAP_FORCE_BASE` | **Retirado — se ignora**, con aviso | `=true` → `JMAP_URL_MODE=rewrite` (el nuevo valor por defecto); `=false` → `JMAP_URL_MODE=trust` |

`JMAP_FORCE_BASE` no tiene alias a propósito: era un booleano cuyo valor por
defecto (`false`, "confía en lo anunciado") es el **contrario** del modo por
defecto de ahora. Mapearlo en silencio, hacia cualquiera de los dos lados,
conservaría o descartaría una decisión del operador sin decírselo. Si este
despliegue dependía de que se usaran las URLs anunciadas tal cual, poner
`JMAP_URL_MODE=trust`; si no, borrar la variable.

### Topologías de conexión al proveedor JMAP (#188)

La conexión Céfiro↔proveedor es **una sola**: JMAP sobre `JMAP_URL`. El
navegador nunca habla con el proveedor — Céfiro proxea adjuntos, subidas y el
SSE del lado servidor — así que las URLs que el proveedor anuncia las consume
**solo este servidor**.

De ahí la regla: **llegar por el camino más directo y reescribir a ese origen,
nunca a través del borde TLS público**. Evita el *hairpin* (salir a la nube y
volver para hablar con tu propio origen) y evita que un CDN corte el SSE, que es
de larga duración por diseño.

Matriz A×B — topología de red × confianza TLS:

| Topología | `JMAP_URL` | `JMAP_URL_MODE` | Confianza TLS |
|---|---|---|---|
| Contenedores en la misma red (edge-core) | `http://stalwart:8080` | `rewrite` | ninguna (http interno) |
| Dedicados, link privado, CA interna | `https://stalwart.interno:8080` | `rewrite` | `NODE_EXTRA_CA_CERTS=/ruta/ca.pem` |
| Dedicados, proveedor con cert público (Let's Encrypt, Cloudflare…) al origen | `https://mail.org.com` | `rewrite` | CAs del sistema (nada que configurar) |
| Dedicados vía túnel (Cloudflare Tunnel u otro) | hostname del túnel | `rewrite` | CAs del sistema |
| Proveedor de host partido (blobs en otro origen alcanzable) | el de la API | `trust` | según el proveedor |

Ejemplo A — contenedores en la misma red:

```env
JMAP_URL=http://stalwart:8080
JMAP_URL_MODE=rewrite
JMAP_AUTH_MODE=basic
```

Ejemplo B — servidores dedicados con CA interna:

```env
JMAP_URL=https://stalwart.interno:8080
JMAP_URL_MODE=rewrite
JMAP_AUTH_MODE=basic
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-interna.pem
```

**Sonda de arranque.** Al arrancar, el servidor hace un `GET
{JMAP_URL}/.well-known/jmap` sin credenciales y deja una línea
`jmap provider probe` con `outcome`, `status`, `urlMode`, `authMode` y —si el
proveedor devolvió una sesión— la `apiUrl` anunciada junto a la ya resuelta. Un
`401` cuenta como **alcanzable**: prueba que la dirección, el DNS, el puerto y
la cadena TLS están bien, que es justo lo que rompe un error de topología.

No falla el arranque a propósito: el proveedor puede levantar después. Qué mirar:

| `outcome` | Significa | Qué revisar |
|---|---|---|
| `reachable` | Contestó (2xx o 401) | Nada. Si además hay `advertisedApiUrl` ≠ `resolvedApiUrl`, `rewrite` está haciendo su trabajo. |
| `not-serving` | Contestó 5xx | El proveedor está arriba pero no sirve JMAP. |
| `unreachable` | Conexión rechazada, DNS, cert no confiable o plazo agotado | `JMAP_URL`, red/firewall, y `NODE_EXTRA_CA_CERTS` si es un cert privado. |

### Autenticidad del remitente (JMAP_AUTHSERV_ID) (#152)

La tilde verde de **"remitente verificado"** sale del veredicto DMARC que Céfiro
lee de la cabecera `Authentication-Results` del mensaje (RFC 8601). El problema:
un mensaje puede traer **varias** cabeceras `Authentication-Results`, y el
remitente puede falsificar una. En **submission autenticada** (un usuario con
credencial de buzón envía por SMTP autenticado) Stalwart **no añade ninguna
cabecera propia**, así que la falsificada por el remitente sería la única — y
antes de este arreglo se devolvía `pass`, pintando la tilde en un correo
suplantado enviado desde una cuenta cualquiera.

**El arreglo — coincidencia de authserv-id (RFC 8601 §5).** El `authserv-id` es
el primer token de la cabecera (antes del primer `;`) y nombra al servidor que
hizo las comprobaciones. Céfiro solo confía en la cabecera cuyo `authserv-id`
coincide con `JMAP_AUTHSERV_ID` (comparación sin distinguir mayúsculas, sin
espacios, y por **token completo**: `evil-mail.test` no coincide con
`mail.test`). Cualquier otra la ignora.

**Cómo averiguar el tuyo.** Es lo que tu MTA receptor estampa como primer token
al añadir la cabecera — normalmente el hostname del servidor de correo. Míralo en
una cabecera real:

- Abre un correo **entrante** (recibido por el puerto 25, no enviado por ti) y
  mira la fuente: la línea `Authentication-Results: <esto>; dmarc=...`. Ese
  `<esto>` es tu authserv-id (p. ej. `mail.cefiro.test`).
- O en Stalwart es el `server.hostname` (a menos que se haya configurado un
  authserv-id explícito). En caso de duda, la cabecera real de un entrante manda.

**Por defecto (sin fijar): a prueba de fallos → `unknown`.** Si `JMAP_AUTHSERV_ID`
está vacío, **ninguna** cabecera se considera de confianza y todos los veredictos
quedan en `unknown`: simplemente no se pinta la tilde. Es deliberado — mejor no
insignia que una falsificable — y el servidor deja un `warn` en cada arranque
(`sender authenticity disabled: set JMAP_AUTHSERV_ID ...`) mientras siga así. No
se adivina solo: fijar uno equivocado confiaría en la cabecera equivocada.

**Recomendación del lado de Stalwart (RFC 8601 §5).** La coincidencia de
authserv-id acota *cuál* cabecera se cree, pero no frena a un atacante que
falsifique **exactamente tu** authserv-id en submission autenticada, donde
Stalwart no añade ninguna propia por delante. Para cerrar ese último hueco, el
MTA receptor debe **eliminar las cabeceras `Authentication-Results` entrantes que
reclamen su propio authserv-id** antes de añadir la suya (justo lo que pide RFC
8601 §5). Revisa la configuración de Stalwart para confirmar que lo hace; si tu
versión no lo hiciera, repórtalo aguas arriba. Esto es guía operativa: el
Stalwart real no se configura desde este repo (el `config.json` del fixture es
solo el bootstrap de RocksDB; los ajustes reales viven en el store y en
`docker-cefiro`).

**Indicador de confianza (#314).** Sobre esta insignia el lector muestra un
segundo nivel solo positivo ("remitente conocido" / "servicio de confianza"),
que también depende de `JMAP_AUTHSERV_ID`: sin él, todo queda en `none`. No
añade variables de entorno; la semilla de servicios y las reglas están en
`docs/ARCHITECTURE.md` ("Indicador de confianza del remitente").

**Base de datos.** El cliente acota la conexión para que una query lenta no
cuelgue el servicio.

| Variable | Por defecto | Qué hace |
|---|---|---|
| `DB_POOL_MAX` | `10` | Tamaño del pool de conexiones. |
| `DB_CONNECT_TIMEOUT_S` | `10` | Plazo del handshake de conexión (s). |
| `DB_IDLE_TIMEOUT_S` | `300` | Cierra conexiones ociosas tras este tiempo (s). |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | Cancela una query que se pasa de este plazo (ms). |

**Cifrado y rotación.** Ver [Rotación de `MASTER_KEY`](#rotación-de-master_key).

| Variable | Por defecto | Qué hace |
|---|---|---|
| `MASTER_KEY_VERSION` | `1` | Versión que se estampa al cifrar. |
| `MASTER_KEY_PREVIOUS` | — | Claves retiradas, como `version:base64key` separadas por comas. |

**Observabilidad.**

| Variable | Por defecto | Qué hace |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`\|`info`\|`warn`\|`error`. Un valor no reconocido cae al de por defecto en vez de silenciar el servidor. |
| `METRICS_TOKEN` | — | Token portador que abre `/metrics`. **Sin él el endpoint no existe** (responde 404). Un nombre de variable mal escrito da exactamente el mismo 404, así que el monitoreo puede desaparecer sin avisar: por eso existe la alerta `CefiroSinMetricasDeApp`. Ver [Métricas y alertas](#métricas-y-alertas). |

**Resto de plazos y límites.**

| Variable | Por defecto | Qué hace |
|---|---|---|
| `OIDC_TIMEOUT_MS` | `10000` | Plazo de las llamadas al proveedor OIDC. |
| `MAX_BODY_BYTES` | `2097152` | Techo global del cuerpo de petición (2 MiB). Excepto la subida de adjuntos, que va en streaming. |
| `TRUSTED_PROXY_HOPS` | `1` | Cuántos proxies añaden su salto a `X-Forwarded-For`. De ello dependen los cinco límites por IP y la columna `ip` de la auditoría. Ver [Proxies de confianza](#proxies-de-confianza). |

### Proxies de confianza

Este proceso no ve nunca la IP del cliente: ve la del proxy. Lo único que puede
decirle quién llamó es `X-Forwarded-For`, y esa cabecera es una **lista de
afirmaciones** en la que solo valen las que ha escrito un proxy nuestro.

**El contrato.** `TRUSTED_PROXY_HOPS` declara cuántos proxies **añaden** su salto
a esa cabecera entre internet y el contenedor. La IP del cliente se lee contando
ese número de entradas **desde la derecha**, que es el extremo al que el cliente
no llega: cada salto de confianza escribe *después* de lo que le entregaron.

```
El cliente manda:   X-Forwarded-For: 9.9.9.9, 8.8.8.8      ← inventado
nginx añade:        X-Forwarded-For: 9.9.9.9, 8.8.8.8, 203.0.113.7
                                                    └──────┘ TRUSTED_PROXY_HOPS=1
```

Antes se tomaba la entrada de la **izquierda**, que bajo un proxy que anexa es
exactamente la parte que escribe quien llama (#238): rotando la cabecera se
conseguía un cubo nuevo por petición y **los cinco límites por IP dejaban de
acotar nada** — incluido el que limita los intentos contra el token de
`/metrics` —, además de llenar la columna `ip` de la auditoría con direcciones
elegidas por el atacante.

**Qué tiene que mandar el proxy.** Que **anexe**, no que sustituya, y que sea el
único camino de red hasta el contenedor:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # anexa $remote_addr
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Host $host;
```

Traefik (`forwardedHeaders`) y Caddy (`X-Forwarded-For`) anexan por defecto y no
necesitan nada más. Un proxy configurado con `proxy_set_header X-Forwarded-For
$remote_addr` (sustituir) **también funciona** con `1`: deja una cadena de un
solo elemento escrito por él.

**Streaming (SSE).** `/api/mail/events` es una respuesta de larga duración.
Responde con `X-Accel-Buffering: no` para que un nginx con `proxy_buffering on`
(el router del ecosistema) no retenga los eventos hasta llenar el búfer o cerrar
la conexión (#316). Solo actúa sobre **el nginx que hace el `proxy_pass`
directo** al contenedor: nginx consume la cabecera y no la reenvía, así que en
una topología de dos saltos (`CDN o balanceador → nginx → contenedor`) el salto
exterior tiene que desactivar el búfer para esa ruta por su cuenta. Traefik y
Caddy no bufferizan respuestas por defecto y no necesitan nada.

**Cómo se cuenta.** Uno por cada proxy que anexa, en el camino real de la
petición:

| Topología | Valor |
|---|---|
| Un nginx/Traefik delante del contenedor (lo que despliega `docker-cefiro`) | `1` |
| CDN o balanceador → nginx → contenedor | `2` |
| El contenedor expuesto directamente a internet | `0` |

**Los dos modos de equivocarse no son simétricos, y eso es deliberado.** Un valor
**mayor** que la cadena real deja la petición sin atribuir y la manda a un cubo
compartido: se pierde granularidad, no seguridad. Un valor **menor** devuelve una
entrada que eligió el cliente, que es el fallo original. Ante la duda, redondear
hacia arriba.

Con `0` la cabecera se ignora por completo y **todos los límites pasan a ser
globales**: un solo atacante puede gastar el presupuesto del login de emergencia
para todo el mundo. Es la respuesta correcta solo si de verdad no hay proxy.

**Cómo comprobarlo.** Con `BOOTSTRAP_MODE` apagado, `POST /api/auth/bootstrap`
responde 404 sin tocar nada, así que no sirve. La comprobación limpia es
`/api/health`, que lleva su propio techo de 60/min por IP:

```sh
# Desde fuera, atravesando el proxy: 60 peticiones deben pasar y la 61 dar 429.
for i in $(seq 1 61); do
  curl -s -o /dev/null -w '%{http_code}\n' https://<APP_URL>/api/health
done | tail -3

# Y lo que prueba el arreglo: falsificar la cabecera NO da presupuesto nuevo.
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'X-Forwarded-For: 1.2.3.4' https://<APP_URL>/api/health   # sigue 429
```

Si esa última línea vuelve a dar `200`, el conteo de saltos no cuadra con la
topología real.

**IA (opcional, apagada por defecto).** Inerte salvo que `AI_ENABLED=true` **y**
haya `AI_API_KEY`.

| Variable | Por defecto | Qué hace |
|---|---|---|
| `AI_ENABLED` | `false` | Interruptor general. |
| `AI_PROVIDER` | `anthropic` | `anthropic` o `openai-compat`. |
| `AI_API_KEY` | — | Credencial del proveedor. |
| `AI_MODEL` | `claude-opus-4-8` | Modelo. |
| `AI_BASE_URL` | — | Raíz de la API, **incluido el `/v1`**. Solo para `openai-compat`; sin ella la IA queda desactivada con un aviso en el log. |
| `AI_TIMEOUT_MS` | `60000` | Plazo de las llamadas al proveedor de IA. |

La configuración del proveedor OIDC (issuer, client id, client secret) **no** va
en el entorno: vive en la base de datos y se edita desde el portal de
administración.

### Desplegar una versión

1. Comprobar que CI está en verde para el commit y que la imagen existe:
   ```sh
   docker manifest inspect ghcr.io/noxvytop/cefiro-webmail:sha-<commit> >/dev/null && echo ok
   ```
2. Anotar **qué etiqueta está corriendo ahora** (es a la que se revierte):
   ```sh
   docker inspect --format '{{.Config.Image}}' <contenedor>
   ```
3. Fijar la etiqueta nueva en `docker-cefiro` y aplicar (`docker compose up -d`).
   Las migraciones de esquema se aplican **solas en el arranque**; no hay paso
   manual de migración.
4. Esperar a que el contenedor quede `healthy` y verificar a mano:
   ```sh
   curl -fsS https://<APP_URL>/api/health && echo
   ```
5. Mirar el log del arranque: debe aparecer `server started`, y `mail proxy`
   con `configured: true` si hay Stalwart.

Si el arranque falla, el proceso sale con código 1 y **dice por qué** en una
línea JSON:

| `msg` | Qué pasó |
|---|---|
| `invalid configuration` | Falta o sobra una variable de entorno. |
| `database unavailable at startup` | No se pudo conectar a Postgres. El campo `hint` dice qué mirar y `step` en cuál de los dos pasos de base de datos ocurrió. |
| `database migration failed` / `key version scan failed` | Se llegó a Postgres, pero la migración o el barrido de versiones de clave falló. No es transitorio: mirar `error`. |
| `invalid master key ring` | `MASTER_KEY` malformada. |
| `master key ring cannot decrypt stored rows` | Falta una clave retirada en `MASTER_KEY_PREVIOUS`; el log lista las versiones que faltan. |

**El contenedor casi siempre arranca antes que su base de datos**, así que un
fallo de *conexión* no se da por perdido a la primera: son 6 intentos con espera
creciente entre ellos (1, 2, 4, 8 y 16 s, o sea 31 s de espera, más lo que tarde
en fallar cada intento — hasta `DB_CONNECT_TIMEOUT_S` cada uno). Cada reintento
deja una línea `database not reachable yet, retrying` con el número de intento y
cuánto va a esperar. Si la base no aparece en ese plazo, sale con
`database unavailable at startup`. Cualquier otro fallo —una migración que
revienta, un rol sin permisos— **no se reintenta**: no se arregla solo, y
reintentarlo únicamente retrasa la línea de log que hace falta.

### Checklist de primer arranque

1. Postgres levantado y accesible, base creada y vacía.
2. Generar la clave maestra y guardarla en el gestor de secretos:
   `bun apps/server/scripts/generate-master-key.ts`. **Si se pierde, las
   credenciales de correo de todos los usuarios son irrecuperables.**
3. Configurar `DATABASE_URL`, `MASTER_KEY`, `APP_URL`, `NODE_ENV=production`.
4. Generar la credencial de emergencia y guardarla en el gestor de secretos
   junto a `MASTER_KEY`:
   ```sh
   openssl rand -base64 24
   ```
   Arrancar con `BOOTSTRAP_MODE=true` y esa cadena en `BOOTSTRAP_PASSWORD`.
   **La contraseña no se busca en el log: la fija quien despliega.** El
   arranque solo avisa de que el modo está activo:
   ```sh
   docker compose logs cefiro-webmail | grep "bootstrap mode active"
   ```
   El usuario del login de emergencia es `bootstrap-admin`; la contraseña es la
   que se acaba de generar. Sin `BOOTSTRAP_PASSWORD` (o con menos de 24
   caracteres) el proceso registra `invalid configuration` y sale con código 1.
5. Entrar en `<APP_URL>/setup` con esa credencial y configurar: el
   administrador real, el proveedor OIDC (Authentik) y las credenciales de
   buzón iniciales.
6. **Poner `BOOTSTRAP_MODE=false`, retirar `BOOTSTRAP_PASSWORD` y reiniciar.**
   Mientras esté activo hay un login de administración accesible sin SSO.
   `/api/setup` además **se cierra solo** en cuanto el setup está terminado —
   hay un administrador activo y SSO configurado — aunque la variable se quede
   puesta; a partir de ahí lo que queda abierto es el login de emergencia, y
   eso es lo que retira el paso 6.
7. Comprobar que el login SSO funciona de punta a punta con un usuario real.
8. Configurar `METRICS_TOKEN` y enganchar el scrape
   ([Métricas y alertas](#métricas-y-alertas)).
9. Programar la dbSOS diaria y **verificar que la primera copia se escribe**
   ([dbSOS](#dbsos--copia-de-emergencia-de-la-base-de-datos)). Los scripts salen
   de la propia imagen: ver [Cómo conseguir los scripts](#cómo-conseguir-los-scripts).
10. Dar de alta la alerta de "sin copia en 24 h". Un backup que nadie vigila no
    es DR.

## Promoción y versionado

CI ya sabe producir las etiquetas; lo que faltaba escrito es **quién aprieta el
botón y con qué criterio**. El paso de `preproduc` a `main` es el momento de
mayor riesgo del ciclo, así que es el que menos puede depender de la memoria de
nadie.

### Las dos ramas

| Rama | Qué es | Qué publica |
|---|---|---|
| `preproduc` | Rama de integración. **Todos los PR van aquí.** Es lo que corre en preproducción. | `:staging` + `:sha-<commit>` |
| `main` | Rama por defecto. **Es lo que corre en producción.** Solo entra por promoción desde `preproduc`. | `:latest` + `:sha-<commit>` |

### Criterios de entrada

Promueve el responsable de la release (quien mantiene el repositorio), y no
antes de que **todo** esto sea cierto:

1. CI en verde sobre el commit exacto de `preproduc` que se va a promover —
   incluida la prueba de humo que arranca la imagen publicada
   ([Desplegar una versión](#desplegar-una-versión)).
2. `:staging` lleva desplegado en preproducción el tiempo suficiente para
   haberse usado de verdad: login SSO con un usuario real, enviar y recibir un
   correo, `/api/health` en `200`.
3. Ningún issue abierto de severidad alta de la ola que se promueve.
4. La dbSOS tiene una copia verificada reciente
   (`cefiro_dbsos_last_success_timestamp_seconds` fresco). Si la ola trae una
   migración **destructiva**, además una copia a mano justo antes — ver
   [Revertir](#revertir-rollback), porque el esquema no se revierte solo.

### Cómo se promueve y cómo se corta la versión

1. PR de `preproduc` a `main`, **con merge commit** (no squash): así cada commit
   conserva el `:sha-<commit>` con el que ya se probó en preproducción, y el
   rollback puede apuntar a cualquiera de ellos.
2. Esperar a que CI publique desde `main`: `:latest` + `:sha-<commit>`.
3. Cortar la versión sobre ese commit exacto de `main`:
   ```sh
   git checkout main && git pull
   git tag -a v1.2.0 -m "v1.2.0"
   git push origin v1.2.0
   ```
   El push del tag dispara el pipeline otra vez y publica `:v1.2.0` (+ `:latest`
   y `:sha-<commit>`). Semver: **MAJOR** si hay migración destructiva o cambio
   incompatible de configuración, **MINOR** si hay funcionalidad nueva,
   **PATCH** si solo hay correcciones.
4. Desplegar en producción **pinneando `:vX.Y.Z`**, nunca `:latest`, y seguir la
   comprobación de [Desplegar una versión](#desplegar-una-versión).

### Qué se comprueba después

Lo mismo que tras un rollback, y por la misma razón — que el proceso que corre
es el que se cree: `/api/health` en `200`, `server started` sin `unhandled
error` en el log, un login real, un correo de prueba, y en `/metrics`
`cefiro_process_start_time_seconds` cambiado con la tasa de 5xx en su línea base.

### Efecto lateral: los issues no se cierran al mergear en `preproduc`

`Closes #N` en un PR **solo cierra el issue cuando el commit llega a la rama por
defecto**, y aquí la rama por defecto es `main`. Como los PR van a `preproduc`,
los issues de una ola siguen abiertos hasta que se promueve — aunque el trabajo
lleve semanas hecho y desplegado en preproducción.

No es un fallo, es la consecuencia de tener rama de integración: **la promoción
es lo que los cierra, en bloque**. Conviene no cerrarlos a mano mientras tanto,
porque entonces se pierde el enlace automático entre el issue y el commit que lo
resolvió, que es lo que permite reconstruir después qué entró en cada versión.

## Revertir (rollback)

La aplicación es un contenedor sin estado: revertir es volver a la imagen
anterior. El estado vive en Postgres, así que **lo que hay que mirar después es
si la versión que se revierte cambió el esquema**.

1. Identificar la imagen buena conocida — la que se anotó en el paso 2 del
   despliegue, o:
   ```sh
   # etiquetas publicadas, más nueva primero
   gh api /orgs/NoxvyTop/packages/container/cefiro-webmail/versions \
     --jq '.[].metadata.container.tags | select(length > 0) | .[]' | head -20
   ```
2. Fijar esa etiqueta `:sha-<commit>` (o `:vX.Y.Z`) en `docker-cefiro` y
   `docker compose up -d`. El apagado es ordenado: con SIGTERM el proceso drena
   las peticiones en vuelo antes de cerrar.
3. Comprobar después:
   - `/api/health` responde **200** con `status: "ok"`.
   - En el log aparece `server started` y **no** hay `unhandled error`.
   - Un login real funciona (la sesión sigue siendo válida: las sesiones viven
     en Postgres, no en memoria del proceso).
   - Enviar un correo de prueba y abrir la bandeja.
   - En `/metrics`, `cefiro_process_start_time_seconds` cambió (confirma que el
     proceso es realmente nuevo) y la tasa de 5xx vuelve a la línea base.

**El punto delicado: las migraciones no se revierten.** El código sube el
esquema en el arranque y no lo baja. Volver a una imagen anterior sobre un
esquema más nuevo funciona mientras el cambio sea aditivo (una columna o tabla
nuevas que la versión vieja simplemente ignora), que es lo normal. Si la versión
que se revierte **borró o renombró** algo, el rollback de imagen no basta: hay
que restaurar la base con la [dbSOS](#dbsos--copia-de-emergencia-de-la-base-de-datos)
al punto anterior al despliegue, y eso **pierde el correo enviado y los cambios
hechos desde entonces**. Antes de desplegar una migración destructiva, hacer una
copia dbSOS a mano.

## Diagnóstico (triage)

### Dónde están los logs

Una línea JSON por evento, a la salida estándar del proceso (`error` y `warn`
por stderr, el resto por stdout). No hay ficheros de log: los recoge el runtime
de contenedores.

```sh
docker compose logs -f cefiro-webmail                  # en vivo
docker compose logs --since 30m cefiro-webmail         # ventana reciente
docker compose logs cefiro-webmail | grep '"level":"error"'
```

Campos: `level`, `msg`, `time` (ISO-8601 UTC), `traceId` y los propios de cada
evento. Los mensajes que más se buscan:

| `msg` | Qué es |
|---|---|
| `request` | Un registro de acceso por respuesta: `method`, `path`, `status`, `durationMs`. `path` es el **patrón** de ruta (`/api/mail/threads/:id`), nunca el id concreto. |
| `error response` | El sobre de error que se le devolvió al cliente: `code`, `status`. |
| `domain error` / `unhandled error` | Error de dominio (esperado) y error no controlado (500, hay que mirarlo). |
| `server started` | Arranque correcto. |
| `bootstrap mode active` | **`BOOTSTRAP_MODE` sigue en `true`.** Solo avisa; la credencial nunca se registra. |
| `oidc callback failed` | Un login SSO se rompió. `stage` dice en qué paso (`discovery`, `token_exchange`, `id_token`, `user_lookup`, `user_provision`, `session`) y `errorClass`/`errorCode` de qué clase de error se trata. |

`LOG_LEVEL=debug` sube el detalle sin redesplegar la imagen. Ninguna credencial
aparece jamás en los logs —tampoco la de emergencia, que el servidor ya no
genera ni escribe (#235), ni ningún `id_token`: de un fallo de login se publica
la **clase** del error, nunca su mensaje— y el registro de acceso guarda el
patrón de ruta precisamente para no dejar un historial de lectura por usuario.

### Correlacionar por `traceId`

Cada petición lleva un identificador único. El usuario lo tiene delante: sale en
el cuerpo del error (`{ code, message, traceId }`) y en la cabecera
`x-trace-id` de **toda** respuesta.

```sh
docker compose logs cefiro-webmail | grep '<traceId>'
```

Eso devuelve la historia completa de esa petición: el registro de acceso, el
código de error exacto que se devolvió, y las líneas de diagnóstico profundas
—plazo saliente agotado, sincronización Sieve, cosecha de contactos, adaptador
de IA—, que arrastran el mismo `traceId` aunque se escriban varias capas por
debajo del handler o en un tick posterior.

Si un usuario reporta un fallo **sin** identificador: acotar por ventana de
tiempo y ruta (`grep '"status":5'`), o pedirle que reproduzca y lea el `traceId`
del mensaje de error.

### Códigos de error

El sobre es siempre `{ code, message, traceId }`; `message` es una clave i18n,
no texto para el operador. El `code` es lo que se busca.

| Código | HTTP | Qué significa |
|---|---|---|
| `invalid_body`, `invalid_query`, `invalid_identity`, `invalid_order` | 400 | El cliente mandó algo que no valida. |
| `unauthorized` | 401 | Sin sesión o sesión caducada. Normal en `/api/auth/me`. |
| `forbidden` | 403 | Sesión válida sin permiso de administración. |
| `not_found` | 404 | Ruta o recurso inexistente. |
| `user_exists`, `contact_exists`, `last_admin`, `self_demotion`, `self_archive`, `not_in_trash`, `destroy_failed`, `update_failed` | 409 | Conflicto de estado; la operación se rechaza a propósito. |
| `payload_too_large` | 413 | Cuerpo por encima de `MAX_BODY_BYTES`. |
| `too_many_requests` | 429 | Límite del login de emergencia. |
| `rate_limited` | 429 | Límite de `/api/health` o `/metrics`. |
| `ai_rate_limited` | 429 | Cuota de IA por usuario agotada. |
| `too_many_streams` | 429 | El usuario ya tiene 8 streams SSE abiertos (#241). Casi siempre un cliente en bucle de reconexión, no un usuario con muchas pestañas. |
| `internal` | 500 | **Error no controlado.** Siempre viene con un `unhandled error` en el log. |
| `ai_disabled` | 501 | Se pidió IA con `AI_ENABLED=false` o sin `AI_API_KEY`. |
| `stalwart_unavailable`, `jmap_error`, `mail_auth_failed`, `send_failed`, `save_draft_failed`, `mailbox_roles_missing` | 502 | Stalwart contestó mal, o no contestó. Mirar Stalwart, no la app. |
| `sieve_invalid`, `sieve_sync_failed` | 502 | Los filtros no se pudieron compilar o subir a Stalwart. |
| `oidc_discovery_failed`, `oidc_exchange_failed`, `oidc_email_missing` | 502 | El proveedor OIDC falló o devolvió un token sin correo. Mirar Authentik. |
| `ai_provider_error` | 502 | El proveedor de IA falló. |
| `database_unavailable` | 503 | Postgres caído o inalcanzable. **No es un bug de la app.** |
| `mail_not_configured` | 503 | Falta `JMAP_URL`. |
| `mail_credentials_missing` | 503 | El usuario no tiene credencial de buzón dada de alta. |
| `sso_not_configured` | 503 | No hay proveedor OIDC configurado en el portal de administración. |
| `upstream_timeout` | 504 | Un servicio externo aceptó la conexión y no respondió dentro del plazo. Es lento, no caído — la distinción importa. |

Regla de lectura rápida: **4xx es el cliente, 502/503/504 es una dependencia,
500 somos nosotros.** Solo el 500 justifica despertar a alguien.

### Qué significa `/api/health` degradado

`/api/health` es una señal de **readiness**, no de liveness: responde `200` con
`{"status":"ok"}` cuando todas las dependencias contestan, y `503` con
`{"status":"degraded"}` en cuanto una falla, para que el balanceador o el
orquestador saquen la instancia de rotación.

```sh
curl -s https://<APP_URL>/api/health | jq
{ "status": "degraded", "checks": { "postgres": true, "stalwart": false } }
```

`checks` dice **cuál** falló. `stalwart: false` significa que la sonda JMAP no
contestó dentro de su presupuesto (2 s): puede estar caído o simplemente lento,
y para readiness es lo mismo.

Un `503` aquí **no se arregla reiniciando el contenedor**: es un contenedor sano
informando de que una dependencia suya no lo está. Reiniciar en bucle solo
esconde el síntoma. Ir a Postgres o a Stalwart.

Detalles que evitan sustos: los chequeos corren en paralelo, cada uno con un
presupuesto de 2 s que ahora además **cancela** la llamada al vencer (#242 —
antes se dejaba de esperar sin abortar, y cada sondeo con caché fría dejaba
corriendo por detrás un fetch a Stalwart de hasta 10 s), el resultado se
**cachea unos segundos** (N sondeos no son N llamadas a Stalwart) y el endpoint
lleva su propio límite de tasa.

### Vivacidad (`/api/health/live`) frente a readiness (`/api/health`)

Son dos preguntas distintas y desde #242 tienen dos endpoints distintos:

| Endpoint | Pregunta | Quién lo sondea | Qué hacer con un fallo |
|---|---|---|---|
| `/api/health/live` | ¿Está en pie este proceso? | El `HEALTHCHECK` del contenedor | Reiniciar el contenedor |
| `/api/health` | ¿Puede servir tráfico ahora? | El balanceador / la readiness del orquestador | Sacar la instancia de rotación e ir a la dependencia |

`/api/health/live` no toca ninguna dependencia: responde `200 {"status":"alive"}`
mientras el proceso conteste HTTP.

**Por qué el `HEALTHCHECK` del contenedor mira solo la vivacidad.** Sondeaba
`/api/health`, que devuelve 503 cuando una dependencia está caída — así que con
Stalwart caído Docker marcaba **enfermo** el contenedor del webmail. Y `unhealthy`
no es una etiqueta: Swarm reinicia la tarea, `depends_on: service_healthy` no
arranca lo que espera por ella, y el panel enseña el webmail roto. El proceso,
mientras tanto, está perfectamente: sirve la SPA, atiende el resto de las rutas y
responde 503 en readiness, que es justo lo que se le pide. Reiniciar este
contenedor nunca ha arreglado un Postgres o un Stalwart caído, así que atar la
salud del contenedor a sus dependencias convierte un incidente en dos.

El estado de las dependencias **no se ha movido a ningún sitio**: sigue en
`/api/health`, con el detalle por chequeo, que es donde lo leen el balanceador y
la readiness del orquestador.

```yaml
# docker-compose / swarm: la vivacidad la comprueba la imagen; la readiness, quien
# reparte el tráfico. En Kubernetes serían livenessProbe y readinessProbe.
healthcheck:
  test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:8080/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
```

El `HEALTHCHECK` sondea cada 30 s con 5 s de plazo y 3 reintentos, dos órdenes de
magnitud por debajo del límite de tasa que comparte con `/api/health`, y además
conecta directo (sin `X-Forwarded-For`), o sea en un cubo al que no llega ningún
cliente que venga por el proxy: ese límite nunca puede ser lo que marque una
instancia sana como enferma.

## Métricas y alertas

### `/metrics`

Endpoint Prometheus en `/metrics` (fuera de `/api`: es superficie de operador,
no del SPA).

**Autorización: token portador, opt-in.** Sin `METRICS_TOKEN` configurado el
endpoint **responde 404**, así que una instancia que nunca activó métricas ni
siquiera confirma que existe. Con el token puesto, un scrape sin credencial o
con la equivocada recibe 401, y el endpoint lleva su propio límite de tasa —
separado del de `/api/health`— para que ni un scraper desbocado pueda gastar el
presupuesto de la sonda de readiness ni un adivinador de tokens pueda insistir
gratis. El token se compara en tiempo constante.

Por qué no público: las métricas dibujan el inventario de rutas, la curva de
errores y el momento exacto en que una dependencia cae — un mapa de cuándo el
servicio está más débil. Y por qué no detrás de sesión de administración: ningún
Prometheus sabe mantener una cookie de usuario.

El renderizado **reutiliza la sonda cacheada de `/api/health`** y no hace
ninguna llamada saliente propia: un scrape no puede convertirse en carga contra
Stalwart.

**El 404 es ambiguo a propósito, y por eso hay que alertar sobre la ausencia.**
"Sin token" y "token mal escrito" se ven igual desde fuera —esa es justamente la
propiedad que protege a una instancia sin métricas—, así que un `METRICS_TOKEN`
con una letra de más apaga el monitoreo en silencio. El servidor valida ahora la
variable con el mismo esquema que el resto de la configuración (#259), lo que
descarta el caso de un valor vacío o con espacios, pero **ningún esquema puede
ver una variable cuyo nombre nunca se escribió**: eso lo caza la alerta
`CefiroSinMetricasDeApp` de más abajo, y no hay otra forma.

| Métrica | Tipo | Para qué |
|---|---|---|
| `cefiro_http_requests_total{method,route,status}` | contador | Tráfico y tasa de error por ruta. `route` es el patrón, y todo lo no ruteado cae en `<unmatched>` (un escáner no puede inflar la cardinalidad). |
| `cefiro_http_request_duration_seconds{method,route}` | histograma | Latencia de entrada; percentiles con `histogram_quantile`. |
| `cefiro_outbound_requests_total{dependency,outcome}` | contador | Llamadas **salientes** por dependencia (`stalwart`\|`oidc`\|`ai`) y desenlace (`ok`\|`error`\|`timeout`). |
| `cefiro_outbound_request_duration_seconds{dependency}` | histograma | Latencia saliente hasta las cabeceras de respuesta. |
| `cefiro_sse_streams_open` | gauge | Streams SSE (`/api/mail/events`) abiertos ahora mismo. |
| `cefiro_shared_mailbox_copies_total{result}` | contador | Copias automáticas de buzones compartidos (#313) intentadas, por desenlace: `copied`, `failed` (rechazada o con error del proveedor; el detalle va al log como `shared mailbox copy: copy refused/failed`, con `userId` y `emailId`) y `skipped` (el miembro ya tenía la copia; una tasa que sube indica ciclos que se cortan a medias). Las tres series existen desde el primer scrape, en cero. |
| `cefiro_dependency_up{dependency}` | gauge | `1`/`0` por dependencia, del último chequeo de salud. |
| `cefiro_process_start_time_seconds` | gauge | Arranque del proceso. Delata un bucle de reinicios y explica un contador que vuelve a cero. |

**Las tres familias salientes son las que contestan "¿qué dependencia va
lenta?"** (#240). Hasta ellas solo había métricas de **entrada**: se veía que
una petición había fallado o tardado, nunca por culpa de cuál — y
`cefiro_dependency_up` no ayuda, porque es un booleano que sigue valiendo `1`
con un Stalwart que contesta cada sondeo en 1,9 s. Salen del único sitio por el
que pasan todas las llamadas salientes (`core/deadline.ts`), que es también lo
único que sabe distinguir un **plazo agotado** (`timeout`: la dependencia acepta
la conexión y no contesta) de una **conexión rechazada** (`error`: no está). Los
primeros movimientos son distintos, por eso son etiquetas distintas.

`cefiro_sse_streams_open` es el otro punto ciego: `/api/mail/events` es una
petición que dura horas, así que no aparece en los contadores de entrada hasta
que termina. Un valor que sube y no baja es una fuga de conexiones; comparado
con el número de usuarios activos, dice si alguien está en bucle de reconexión.
Cada usuario tiene un tope de 8 simultáneos y el servidor cierra el stream tras
90 s sin recibir nada de Stalwart (#241), así que en régimen normal esta línea
se estabiliza sola.

Scrape (en el Prometheus del despliegue, no en este repo):

```yaml
scrape_configs:
  - job_name: cefiro-webmail
    scrape_interval: 15s
    metrics_path: /metrics
    authorization:
      credentials: "<METRICS_TOKEN>"
    static_configs:
      - targets: ["cefiro-webmail:8080"]
```

### La dbSOS se reporta sola

`scripts/db-backup.sh` publica el resultado de cada ejecución en un fichero de
texto Prometheus, escrito de forma atómica, en `DBSOS_STATUS_FILE` (por defecto
`$DBSOS_DIR/dbsos-status.prom`):

```
cefiro_dbsos_last_run_timestamp_seconds 1785543137
cefiro_dbsos_last_run_exit_code 0
cefiro_dbsos_last_success_timestamp_seconds 1785543136
cefiro_dbsos_last_success_size_bytes 4718592
```

`last_success` es la métrica que importa y **sobrevive a las ejecuciones
fallidas**: si el backup de hoy falla, ahí sigue la marca de la última copia
buena, que es lo que distingue un fallo de una hora de uno de tres semanas. Un
`0` significa "nunca", y la alerta de abajo también lo caza.

**Se recoge por otra vía que `/metrics`, y tiene que ser así.** Son dos fuentes
en el mismo Prometheus:

| | `/metrics` | El `.prom` de la dbSOS |
|---|---|---|
| Qué mide | El proceso del webmail | Un trabajo de backup que corre **fuera** del contenedor |
| Cómo se recoge | Scrape HTTP directo, con `METRICS_TOKEN` | *Textfile collector* de node_exporter en la máquina que lo ejecuta |
| Si el proceso está caído | La serie desaparece (→ `CefiroSinMetricasDeApp`) | Sigue publicándose: el backup no depende del webmail |

El endpoint del servidor **no** sirve ese fichero a propósito. La imagen no lleva
`pg_dump` ni `openssl` y la dbSOS corre en otro sitio (ver [dbSOS](#dbsos--copia-de-emergencia-de-la-base-de-datos)),
así que para servirlo tendría que leer un fichero que no le pertenece y que, el
día que de verdad importa, es justo el que sobrevive al contenedor caído. Un
backup que se deja de ver porque el webmail se cayó es exactamente el fallo que
`CefiroSinBackup24h` existe para no tener.

Para que Prometheus lo lea, apuntarlo al directorio del *textfile collector* de
node_exporter en la máquina que corre la dbSOS:

```sh
# node_exporter --collector.textfile.directory=/var/lib/node_exporter/textfile
DBSOS_STATUS_FILE=/var/lib/node_exporter/textfile/cefiro-dbsos.prom
```

Con las dos fuentes en el mismo Prometheus, las alertas de más abajo se escriben
igual estén donde estén las métricas; solo hay que recordar que las
`cefiro_dbsos_*` llevan las etiquetas del `job` de node_exporter y no las del
webmail, así que no se pueden unir por `instance` sin más.

**Contrato de códigos de salida** para el planificador (cron, systemd timer, o
el orquestador que lo lance):

| Código | Qué pasó | Urgencia |
|---|---|---|
| `0` | Copia escrita y verificada. | — |
| `1` | Error de configuración: falta una variable, una herramienta o la clave no se puede leer. | Alta: **la dbSOS no está corriendo en absoluto**. |
| `2` | Falló el volcado o el cifrado. No se publicó nada. | Alta si se repite. |
| `3` | El archivo se escribió, no se pudo releer y **se descartó**. | Máxima: apunta a corrupción o a la clave equivocada. |

Un `systemd` timer con `OnFailure=` sobre el servicio ya alerta con esto sin
tocar Prometheus.

### Reglas de alerta (ejemplo)

La pila de alertas vive fuera de este repo; esto es el contenido, no la
instalación.

```yaml
groups:
  - name: cefiro-webmail
    rules:
      # LA alerta que justifica todo lo anterior: da igual por qué falló la
      # dbSOS, lo grave es que no haya una copia buena reciente.
      - alert: CefiroSinBackup24h
        expr: time() - cefiro_dbsos_last_success_timestamp_seconds > 86400
        for: 15m
        labels: { severity: critical }
        annotations:
          summary: "dbSOS: sin copia verificada en más de 24 h"

      # Y el fallo silencioso de la propia vigilancia: si la métrica desaparece,
      # el backup podría llevar semanas parado sin que nada se queje.
      - alert: CefiroBackupSinMetrica
        expr: absent(cefiro_dbsos_last_success_timestamp_seconds)
        for: 30m
        labels: { severity: critical }

      - alert: CefiroBackupUltimaEjecucionFallida
        expr: cefiro_dbsos_last_run_exit_code != 0
        for: 5m
        labels: { severity: warning }

      # El mismo fallo silencioso, un piso más arriba (#259): si las métricas de
      # la APLICACIÓN desaparecen, todas las alertas de abajo dejan de poder
      # dispararse y el panel se queda en blanco, que es indistinguible de "no
      # pasa nada". Caza las tres formas de perderlas: METRICS_TOKEN mal escrito
      # o borrado (el endpoint deja de existir y responde 404), el scrape
      # apuntando a un destino que ya no está, y el proceso caído del todo.
      - alert: CefiroSinMetricasDeApp
        expr: absent(cefiro_process_start_time_seconds)
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "cefiro-webmail no está exponiendo métricas"
          description: >-
            Comprobar que METRICS_TOKEN sigue configurado (sin él /metrics
            responde 404, igual que si estuviera mal escrito), que el scrape
            apunta al destino correcto y que el contenedor está en pie.

      - alert: CefiroDependenciaCaida
        expr: cefiro_dependency_up == 0
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: "{{ $labels.dependency }} no responde"

      - alert: CefiroErrores5xx
        expr: >
          sum(rate(cefiro_http_requests_total{status=~"5.."}[5m]))
          / sum(rate(cefiro_http_requests_total[5m])) > 0.05
        for: 10m
        labels: { severity: warning }

      - alert: CefiroReinicios
        expr: changes(cefiro_process_start_time_seconds[15m]) > 3
        for: 0m
        labels: { severity: warning }

      # Lo que CefiroDependenciaCaida no ve (#240): una dependencia que
      # responde a la sonda de salud y agota el plazo en las llamadas reales.
      - alert: CefiroDependenciaLenta
        expr: >
          sum by (dependency) (rate(cefiro_outbound_requests_total{outcome="timeout"}[5m]))
          / sum by (dependency) (rate(cefiro_outbound_requests_total[5m])) > 0.05
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.dependency }} agota el plazo en más del 5% de las llamadas"

      # Una fuga de streams SSE crece y no baja. El umbral depende del tamaño
      # del despliegue: el tope es de 8 por usuario, así que hay que ponerlo por
      # encima de (usuarios activos x pestañas habituales).
      - alert: CefiroStreamsSseAcumulados
        expr: cefiro_sse_streams_open > 200
        for: 30m
        labels: { severity: warning }
```

Latencia p95 por ruta, para un panel:

```promql
histogram_quantile(
  0.95,
  sum by (le, route) (rate(cefiro_http_request_duration_seconds_bucket[5m]))
)
```

Y la que responde "¿qué dependencia va lenta?" a las 3 de la mañana, que es la
misma pregunta con la mirada hacia fuera:

```promql
histogram_quantile(
  0.95,
  sum by (le, dependency) (rate(cefiro_outbound_request_duration_seconds_bucket[5m]))
)
```

**Sin Prometheus.** El fichero de estado es texto plano y se puede vigilar con
cron:

```sh
last=$(awk '$1=="cefiro_dbsos_last_success_timestamp_seconds"{print $2}' \
  /var/backups/cefiro/dbsos-status.prom 2>/dev/null || echo 0)
if [ $(( $(date -u +%s) - ${last:-0} )) -gt 86400 ]; then
  echo "dbSOS: sin copia verificada en 24 h (ultima: ${last:-nunca})" | \
    mail -s "CEFIRO: backup parado" ops@example.com
fi
```

## Camino de incidente

1. **Acotar.** `/api/health` primero: si dice `degraded`, el problema es la
   dependencia que señala `checks`, y ahí termina el diagnóstico en la app.
2. **Clasificar** por el código de error que ven los usuarios: 4xx no es una
   caída; 502/503/504 es una dependencia; `internal` (500) somos nosotros.
3. **Correlacionar.** Con un `traceId` de un usuario afectado se reconstruye la
   petición entera. Sin él, `grep '"level":"error"'` sobre la ventana de tiempo.
4. **Mitigar antes que entender.** Si empezó con un despliegue,
   [revertir](#revertir-rollback) es la mitigación más rápida y siempre
   disponible; el análisis viene después, con el servicio en pie.
5. **Recuperar datos solo si hacen falta.** La restauración dbSOS es destructiva
   sobre la base destino y **pierde todo lo escrito desde la copia**. Es la
   última carta, no la primera.
6. **Cerrar.** Comprobar que las alertas vuelven a verde, que
   `cefiro_dbsos_last_success_timestamp_seconds` sigue fresco y que
   `BOOTSTRAP_MODE` quedó en `false` —y `BOOTSTRAP_PASSWORD` retirada— si se
   activó para recuperar el acceso.

Casos frecuentes:

| Síntoma | Causa habitual | Qué hacer |
|---|---|---|
| Todo `503 database_unavailable` | Postgres caído, sin conexiones libres o queries por encima de `DB_STATEMENT_TIMEOUT_MS` | Mirar Postgres; subir `DB_POOL_MAX` solo con evidencia de agotamiento del pool |
| Correo `502 stalwart_unavailable` y health `degraded` | Stalwart caído o el proxy delante de él | Mirar Stalwart; la app se recupera sola cuando vuelva |
| `504 upstream_timeout` intermitente | Dependencia lenta, no caída | Latencia de la dependencia; los plazos (`*_TIMEOUT_MS`) son un techo, no una cura |
| Nadie puede entrar, `oidc_*` en el log | Authentik caído o mal configurado | Mirar `oidc callback failed`: `stage` dice qué paso rompió. Si la configuración OIDC quedó rota, arrancar con `BOOTSTRAP_MODE=true` + `BOOTSTRAP_PASSWORD`, entrar por el **login de emergencia**, corregir en el portal de administración y **volver a `false`**. `/setup` ya no sirve para esto: se cerró al terminar el setup ([#234](#checklist-de-primer-arranque)) |
| Un usuario concreto ve `503 mail_credentials_missing` | Le falta la credencial de buzón | Darla de alta desde el portal de administración |
| El contenedor reinicia en bucle | Fallo de arranque | El log dice cuál: `invalid configuration`, `database unavailable at startup`, `database migration failed`, `invalid master key ring`, `master key ring cannot decrypt stored rows`. Ver [Desplegar una versión](#desplegar-una-versión) |
| Arranca ~30 s tarde y antes se ven `database not reachable yet, retrying` | Postgres tardó en levantar | Normal si termina en `server started`. Si se repite en cada despliegue, ordenar el arranque (`depends_on: condition: service_healthy`) |

## dbSOS — copia de emergencia de la base de datos

Postgres guarda la **única copia** de las credenciales de correo cifradas de
cada usuario, más sesiones y auditoría. La dbSOS es la red de recuperación
**rápida**: una copia de emergencia diaria, cifrada, que se restaura en minutos
si la base se corrompe, para no dejar parados a los usuarios de producción.
(La recuperación completa a nivel infraestructura se hace por otra vía y es más
lenta; la dbSOS no la sustituye, la complementa.)

Scripts: [`scripts/db-backup.sh`](../scripts/db-backup.sh),
[`scripts/db-restore.sh`](../scripts/db-restore.sh) y el ensayo automatizado
[`scripts/db-restore-drill.sh`](../scripts/db-restore-drill.sh).

### RPO y RTO

Números concretos, no aspiraciones. Son el contrato de recuperación que las
alertas y la programación de la dbSOS tienen que sostener:

| Objetivo | Valor | De dónde sale |
|---|---|---|
| **RPO** (pérdida máxima de datos) | **≤ 24 h** con la dbSOS diaria; **≈ el intervalo del backup** si se programa más a menudo | La dbSOS corre una vez al día, así que una corrupción justo antes de la siguiente copia pierde hasta un día de correo enviado, sesiones y auditoría. Para bajarlo, subir la frecuencia del cron (p. ej. cada hora → RPO ≈ 1 h). La copia a nivel infraestructura, con su propia cadencia, es el otro sumando. |
| **RTO** (tiempo hasta volver a servir) | **objetivo ≤ 15 min** por la vía dbSOS | La base es pequeña (usuarios, sesiones, auditoría y credenciales cifradas; los backups verificados rondan pocos MB). El grueso del RTO es humano/operativo: parar la app, `db-restore.sh` (descifrar + `pg_restore -j` en paralelo, segundos-minutos), arrancar y confirmar `/api/health`. La recuperación a nivel infraestructura es la vía **lenta** de respaldo, no la del RTO. |

Estos números valen solo si la restauración de verdad funciona — por eso se
**ensaya de forma automatizada**, ver [Ensayo de restauración](#ensayo-de-restauración-drill).

### Copia fuera del host (obligatorio)

`DBSOS_DIR` es local. Una copia que vive en el mismo host que Postgres **no es
DR**: perder el host (disco, borrado, ransomware, baja del proveedor) se lleva la
base **y todas sus copias a la vez**. Requisito, no recomendación:

- **Cada dump verificado se copia fuera del host** — a otra máquina, un bucket de
  objetos (S3/B2/GCS) o un volumen en otro dominio de fallo. Idealmente con
  versionado/inmutabilidad (object-lock) para que un atacante con acceso al host
  no pueda borrar también el histórico remoto.
- **La clave (`DBSOS_KEY_FILE`) vive aparte de ambos** — ni junto a la base ni
  junto a los backups (el script ya se niega a lo segundo). Sin la clave el dump
  remoto es inútil; con la clave al lado del dump, el cifrado no protege nada.
- El envío remoto es responsabilidad del despliegue (fuera de este repo): el
  paso que sube `dbsos-*.dump.enc` al almacenamiento externo se añade junto al
  cron de la copia diaria.

### Cómo conseguir los scripts

**Viajan dentro de la imagen, en `/app/scripts/`.** El despliegue vive en otro
repositorio y este es privado, así que la imagen es el canal por el que un
operador los obtiene — y obtenerlos así garantiza la versión exacta que
corresponde a la imagen desplegada.

Con el contenedor ya corriendo:

```sh
docker cp cefiro-webmail:/app/scripts/db-backup.sh  /opt/cefiro/dbsos/
docker cp cefiro-webmail:/app/scripts/db-restore.sh /opt/cefiro/dbsos/
```

O desde una etiqueta cualquiera, sin arrancar nada:

```sh
id=$(docker create ghcr.io/noxvytop/cefiro-webmail:sha-<commit>)
docker cp "$id:/app/scripts/." /opt/cefiro/dbsos/
docker rm "$id"
```

**No se ejecutan dentro del contenedor de la aplicación.** Esa imagen no trae
`pg_dump` ni `openssl`, y no debe traerlos: es el contenedor expuesto a la web, y
darle el cliente de Postgres para un trabajo que corre en otro sitio solo amplía
su superficie. Se copian fuera y se ejecutan desde el runner de abajo.

### Requisitos del runner

Una máquina/contenedor con `pg_dump`, `pg_restore`, `psql` y `openssl` en el
`PATH` (p. ej. `postgres:17` + `openssl`, o un `alpine` con `postgresql17-client`
+ `openssl`). **No** la imagen base de Postgres a secas — no trae `openssl`. El
runner se conecta a Postgres por red vía `DATABASE_URL`.

### La clave de cifrado

`DBSOS_KEY_FILE` apunta a un archivo con la passphrase AES. **Vive separada de
los backups** (un secreto montado), nunca dentro de `DBSOS_DIR` — un backup
cifrado cuya clave está al lado no está cifrado. El script se niega a escribir
si detecta que la clave está en el mismo directorio.

Generarla una vez, y guardarla en el gestor de secretos del despliegue:

```sh
head -c 48 /dev/urandom | openssl base64 > dbsos.key   # guardar fuera de banda
```

### Backup diario

```sh
DATABASE_URL="postgres://USER:PASS@HOST:5432/DB" \
DBSOS_KEY_FILE=/run/secrets/dbsos.key \
DBSOS_DIR=/var/backups/cefiro \
DBSOS_RETENTION_DAYS=7 \
  /opt/cefiro/dbsos/db-backup.sh
```

Si el runner es un contenedor (lo habitual, porque la máquina no suele tener
`pg_dump`):

```sh
docker run --rm --network <red-de-cefiro> \
  -v /opt/cefiro/dbsos:/dbsos:ro \
  -v /var/backups/cefiro:/var/backups/cefiro \
  -v /run/secrets/dbsos.key:/run/secrets/dbsos.key:ro \
  -e DATABASE_URL="postgres://USER:PASS@postgres:5432/DB" \
  -e DBSOS_KEY_FILE=/run/secrets/dbsos.key \
  -e DBSOS_DIR=/var/backups/cefiro \
  -e DBSOS_RETENTION_DAYS=7 \
  <imagen-con-pg_dump-y-openssl> /dbsos/db-backup.sh
```

Programarlo una vez al día (cron/systemd timer del despliegue). Produce
`dbsos-<UTC>.dump.enc`: `pg_dump -Fc` (comprimido y **restaurable en paralelo**,
lo que mantiene el RTO bajo) cifrado en streaming — el texto plano nunca toca el
disco. Cada backup se **verifica** (`pg_restore -l`) antes de darse por bueno, así
que un dump truncado no se hace pasar por sano.

Cada ejecución publica además su resultado en un fichero de estado y sale con un
código documentado — ver [La dbSOS se reporta sola](#la-dbsos-se-reporta-sola).
Programarla sin dar de alta la alerta de 24 h deja el agujero que todo esto
existe para tapar.

### Restauración (emergencia)

**Detener la app primero** para que nada escriba a mitad de la restauración. La
BD destino debe existir (crearla vacía, o apuntar a la corrupta — el script
resetea su schema, no la base):

```sh
DATABASE_URL="postgres://USER:PASS@HOST:5432/DB" \
DBSOS_KEY_FILE=/run/secrets/dbsos.key \
DBSOS_DIR=/var/backups/cefiro \
  /opt/cefiro/dbsos/db-restore.sh latest   # o una ruta concreta al .dump.enc
```

Pide confirmación (teclear `restore`); en automatización, `DBSOS_YES=1`. Es
**destructivo** sobre la BD destino: resetea el schema (`DROP SCHEMA public
CASCADE; CREATE SCHEMA public`) y restaura sobre vacío — más robusto que
`pg_restore --clean`, que falla en el orden de los DROP con claves foráneas.
Restaura en paralelo (`DBSOS_JOBS`, por defecto 4) y es idempotente.

### Interacción con la rotación de `MASTER_KEY`

El backup guarda las credenciales **tal como están cifradas** en la base. Un
dump restaurado solo es descifrable con el **llavero de `MASTER_KEY` vigente en
el momento de restaurar**. Si se rotó la clave entre el backup y la
restauración, la clave anterior debe seguir presente en `MASTER_KEY_PREVIOUS`.
Regla práctica: **no retirar una versión de clave del llavero mientras exista
algún backup que la use** — y la ventana de backups es `DBSOS_RETENTION_DAYS`,
no "desde que se rotó".

### Ensayo de restauración (drill)

Un backup que **verifica** (`pg_restore -l`, solo el índice del archivo) no es un
backup que **restaura**: el `-l` no toca los datos. La brecha se cierra con un
ensayo que ejercita la restauración de verdad y **falla ruidosamente** si no
reproduce el origen — nunca sobre datos vivos, siempre sobre bases desechables.

Automatizado en CI: [`scripts/db-restore-drill.sh`](../scripts/db-restore-drill.sh)
crea una base fuente desechable, la siembra, corre el `db-backup.sh` real, restaura
el dump cifrado en una base nueva con el `db-restore.sh` real y compara los datos
(conteos + un hash por tabla, con una clave foránea de por medio para que un orden
de restauración roto no pase inadvertido). Lo corre el job `restore-drill` de
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) en cada push/PR, y
**bloquea el publish** si la restauración deja de reproducir la fuente — así una
vía de restore que se pudre se descubre aquí, no en una emergencia.

Para lanzarlo a mano contra cualquier Postgres donde se puedan crear bases:

```sh
# Usa una BD de mantenimiento (p. ej. `postgres`) para crear/soltar las desechables.
ADMIN_DATABASE_URL="postgres://USER:PASS@HOST:5432/postgres" \
  bash scripts/db-restore-drill.sh
```

No toca la base de la aplicación: crea y suelta `dbsos_drill_src`/`dbsos_drill_dst`
(configurables) y limpia al salir.

## Rotación de `MASTER_KEY`

Por qué el servidor maneja un llavero y no una clave suelta está en
[ARCHITECTURE.md](ARCHITECTURE.md#rotación-de-la-clave-maestra); aquí está el
procedimiento.

Cada fila cifrada guarda en `key_version` la versión con la que se selló. El
llavero es la clave actual (la única que cifra) más las retiradas que todavía
hacen falta para leer filas aún no reescritas.

| Variable | Contenido |
|---|---|
| `MASTER_KEY` | Clave actual, base64 de 32 bytes (44 caracteres). |
| `MASTER_KEY_VERSION` | Versión que se estampa al cifrar; por defecto `1`. |
| `MASTER_KEY_PREVIOUS` | Claves retiradas como `version:base64key`, separadas por comas. |

Un despliegue que solo define `MASTER_KEY` no necesita ningún cambio: es la
versión 1 sin historial, que es lo que el esquema pone por defecto en todas las
columnas `key_version`.

1. Generar la clave nueva y mover la anterior a `MASTER_KEY_PREVIOUS` con la
   versión que llevan sus filas (por ejemplo `1:<clave anterior>`).
2. Poner la clave nueva en `MASTER_KEY` y subir `MASTER_KEY_VERSION` a `2`.
3. Redesplegar. En el arranque el servidor comprueba que el llavero cubre todas
   las `key_version` presentes en `mail_credentials`, `sso_config` e
   `integrations`; si falta alguna **no arranca** y registra cuál
   (`master key ring cannot decrypt stored rows`).
4. Las filas se vuelven a cifrar solas: al leerlas con una clave retirada se
   reescriben con la actual. La reescritura es best-effort — si falla, la
   lectura sigue siendo válida y solo se registra un aviso, porque el correo del
   usuario no puede depender de ella.
5. Cuando ninguna fila conserve la versión antigua se puede retirar su clave de
   `MASTER_KEY_PREVIOUS`. Para comprobarlo:

   ```sql
   select key_version, count(*) from mail_credentials group by key_version;
   select key_version, count(*) from sso_config group by key_version;
   ```

Mientras queden filas en la versión antigua, su clave debe seguir listada: es lo
que evita que una rotación deje credenciales indescifrables. Y ojo con los
backups — ver la [interacción con la dbSOS](#interacción-con-la-rotación-de-master_key).
