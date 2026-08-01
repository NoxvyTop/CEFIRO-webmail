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
| `SESSION_TTL_HOURS` | `12` | Vida de la sesión. |
| `STATIC_DIR` | `/app/apps/web/dist` | Ya viene fijado en la imagen. |
| `SHUTDOWN_GRACE_MS` | `15000` | Plazo para que terminen las peticiones en vuelo al recibir SIGTERM. |
| `SHUTDOWN_DB_TIMEOUT_MS` | `5000` | Plazo para cerrar el pool de Postgres. |

**Correo (Stalwart).** Sin `STALWART_URL` los endpoints de correo responden
`503 mail_not_configured` y el chequeo de Stalwart no se ejecuta.

| Variable | Por defecto | Qué hace |
|---|---|---|
| `STALWART_URL` | — | URL interna del servidor JMAP. |
| `STALWART_TIMEOUT_MS` | `10000` | Plazo de las llamadas salientes a Stalwart. |
| `JMAP_FORCE_BASE` | `false` | Ignora el origen que anuncia la sesión JMAP y usa `STALWART_URL`. Necesario cuando Stalwart está tras un proxy y anuncia una URL interna inalcanzable. |

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
| `METRICS_TOKEN` | — | Token portador que abre `/metrics`. **Sin él el endpoint no existe** (responde 404). Ver [Métricas y alertas](#métricas-y-alertas). |

**Resto de plazos y límites.**

| Variable | Por defecto | Qué hace |
|---|---|---|
| `OIDC_TIMEOUT_MS` | `10000` | Plazo de las llamadas al proveedor OIDC. |
| `MAX_BODY_BYTES` | `2097152` | Techo global del cuerpo de petición (2 MiB). Excepto la subida de adjuntos, que va en streaming. |

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
línea JSON: `invalid configuration` (falta o sobra una variable),
`invalid master key ring` (`MASTER_KEY` malformada) o `master key ring cannot
decrypt stored rows` (falta una clave retirada en `MASTER_KEY_PREVIOUS`; el log
lista las versiones que faltan).

### Checklist de primer arranque

1. Postgres levantado y accesible, base creada y vacía.
2. Generar la clave maestra y guardarla en el gestor de secretos:
   `bun apps/server/scripts/generate-master-key.ts`. **Si se pierde, las
   credenciales de correo de todos los usuarios son irrecuperables.**
3. Configurar `DATABASE_URL`, `MASTER_KEY`, `APP_URL`, `NODE_ENV=production`.
4. Arrancar con `BOOTSTRAP_MODE=true`. El arranque imprime una credencial
   temporal:
   ```sh
   docker compose logs cefiro-webmail | grep "bootstrap mode active"
   ```
   El usuario es `bootstrap-admin` y la contraseña va en esa misma línea.
5. Entrar en `<APP_URL>/setup` con esa credencial y configurar: el
   administrador real, el proveedor OIDC (Authentik) y las credenciales de
   buzón iniciales.
6. **Poner `BOOTSTRAP_MODE=false` y reiniciar.** Mientras esté activo, el log
   escribe una contraseña de administración en claro en cada arranque.
7. Comprobar que el login SSO funciona de punta a punta con un usuario real.
8. Configurar `METRICS_TOKEN` y enganchar el scrape
   ([Métricas y alertas](#métricas-y-alertas)).
9. Programar la dbSOS diaria y **verificar que la primera copia se escribe**
   ([dbSOS](#dbsos--copia-de-emergencia-de-la-base-de-datos)).
10. Dar de alta la alerta de "sin copia en 24 h". Un backup que nadie vigila no
    es DR.

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
| `bootstrap mode active` | **`BOOTSTRAP_MODE` sigue en `true`.** |

`LOG_LEVEL=debug` sube el detalle sin redesplegar la imagen. Ninguna credencial
aparece jamás en los logs, y el registro de acceso guarda el patrón de ruta
precisamente para no dejar un historial de lectura por usuario.

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
| `internal` | 500 | **Error no controlado.** Siempre viene con un `unhandled error` en el log. |
| `ai_disabled` | 501 | Se pidió IA con `AI_ENABLED=false` o sin `AI_API_KEY`. |
| `stalwart_unavailable`, `jmap_error`, `mail_auth_failed`, `send_failed`, `save_draft_failed`, `mailbox_roles_missing` | 502 | Stalwart contestó mal, o no contestó. Mirar Stalwart, no la app. |
| `sieve_invalid`, `sieve_sync_failed` | 502 | Los filtros no se pudieron compilar o subir a Stalwart. |
| `oidc_discovery_failed`, `oidc_exchange_failed`, `oidc_email_missing` | 502 | El proveedor OIDC falló o devolvió un token sin correo. Mirar Authentik. |
| `ai_provider_error` | 502 | El proveedor de IA falló. |
| `database_unavailable` | 503 | Postgres caído o inalcanzable. **No es un bug de la app.** |
| `mail_not_configured` | 503 | Falta `STALWART_URL`. |
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

Detalles que evitan sustos: los chequeos corren en paralelo, el resultado se
**cachea unos segundos** (N sondeos no son N llamadas a Stalwart) y el endpoint
lleva su propio límite de tasa. El `HEALTHCHECK` del contenedor sondea cada 30 s
con 5 s de plazo y 3 reintentos, dos órdenes de magnitud por debajo del límite,
así que ese límite nunca puede ser lo que marque una instancia sana como
enferma.

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

| Métrica | Tipo | Para qué |
|---|---|---|
| `cefiro_http_requests_total{method,route,status}` | contador | Tráfico y tasa de error por ruta. `route` es el patrón, y todo lo no ruteado cae en `<unmatched>` (un escáner no puede inflar la cardinalidad). |
| `cefiro_http_request_duration_seconds{method,route}` | histograma | Latencia; percentiles con `histogram_quantile`. |
| `cefiro_dependency_up{dependency}` | gauge | `1`/`0` por dependencia, del último chequeo de salud. |
| `cefiro_process_start_time_seconds` | gauge | Arranque del proceso. Delata un bucle de reinicios y explica un contador que vuelve a cero. |

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

Para que Prometheus lo lea, apuntarlo al directorio del *textfile collector* de
node_exporter en la máquina que corre la dbSOS:

```sh
# node_exporter --collector.textfile.directory=/var/lib/node_exporter/textfile
DBSOS_STATUS_FILE=/var/lib/node_exporter/textfile/cefiro-dbsos.prom
```

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
```

Latencia p95 por ruta, para un panel:

```promql
histogram_quantile(
  0.95,
  sum by (le, route) (rate(cefiro_http_request_duration_seconds_bucket[5m]))
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
   `BOOTSTRAP_MODE` quedó en `false` si se activó para recuperar el acceso.

Casos frecuentes:

| Síntoma | Causa habitual | Qué hacer |
|---|---|---|
| Todo `503 database_unavailable` | Postgres caído, sin conexiones libres o queries por encima de `DB_STATEMENT_TIMEOUT_MS` | Mirar Postgres; subir `DB_POOL_MAX` solo con evidencia de agotamiento del pool |
| Correo `502 stalwart_unavailable` y health `degraded` | Stalwart caído o el proxy delante de él | Mirar Stalwart; la app se recupera sola cuando vuelva |
| `504 upstream_timeout` intermitente | Dependencia lenta, no caída | Latencia de la dependencia; los plazos (`*_TIMEOUT_MS`) son un techo, no una cura |
| Nadie puede entrar, `oidc_*` en el log | Authentik caído o mal configurado | Si la configuración OIDC quedó rota, arrancar con `BOOTSTRAP_MODE=true`, corregir en `/setup` y **volver a `false`** |
| Un usuario concreto ve `503 mail_credentials_missing` | Le falta la credencial de buzón | Darla de alta desde el portal de administración |
| El contenedor reinicia en bucle | Fallo de arranque | El log dice cuál: `invalid configuration`, `invalid master key ring`, `master key ring cannot decrypt stored rows` |

## dbSOS — copia de emergencia de la base de datos

Postgres guarda la **única copia** de las credenciales de correo cifradas de
cada usuario, más sesiones y auditoría. La dbSOS es la red de recuperación
**rápida**: una copia de emergencia diaria, cifrada, que se restaura en minutos
si la base se corrompe, para no dejar parados a los usuarios de producción.
(La recuperación completa a nivel infraestructura se hace por otra vía y es más
lenta; la dbSOS no la sustituye, la complementa.)

Scripts: [`scripts/db-backup.sh`](../scripts/db-backup.sh) y
[`scripts/db-restore.sh`](../scripts/db-restore.sh).

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
  scripts/db-backup.sh
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
  scripts/db-restore.sh latest      # o una ruta concreta al .dump.enc
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

### Nunca probar sobre datos vivos

El round-trip (backup → corromper → restaurar) se prueba **sobre una copia
desechable**, jamás sobre la base de producción. Patrón verificado:

```sh
# fuente sana → backup → restaurar en una BD nueva y vacía → comparar conteos
createdb cefiro_sos_test
DATABASE_URL=".../origen"  DBSOS_KEY_FILE=... scripts/db-backup.sh
DATABASE_URL=".../cefiro_sos_test" DBSOS_KEY_FILE=... DBSOS_YES=1 scripts/db-restore.sh latest
# select count(*) en ambas debe coincidir; dropdb cefiro_sos_test
```

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
