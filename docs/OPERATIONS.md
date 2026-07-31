# Operaciones

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

### Interacción con la rotación de `MASTER_KEY` (#172)

El backup guarda las credenciales **tal como están cifradas** en la base. Un
dump restaurado solo es descifrable con el **llavero de `MASTER_KEY` vigente en
el momento de restaurar**. Si se rotó la clave entre el backup y la
restauración, la clave anterior debe seguir presente en `MASTER_KEY_PREVIOUS`
(ver la sección de rotación en `ARCHITECTURE.md`). Regla práctica: no retirar
una versión de clave del llavero mientras exista algún backup que la use.

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

## Variables de entorno de la base de datos

Además de `DATABASE_URL` (obligatoria), el cliente Postgres acota la conexión
(#191) para que una query lenta no cuelgue el servicio. Todas opcionales, con
los valores por defecto ya activos:

| Variable | Por defecto | Qué hace |
|---|---|---|
| `DB_POOL_MAX` | 10 | Tamaño del pool de conexiones. |
| `DB_CONNECT_TIMEOUT_S` | 10 | Plazo del handshake de conexión (s). |
| `DB_IDLE_TIMEOUT_S` | 300 | Cierra conexiones ociosas tras este tiempo (s). |
| `DB_STATEMENT_TIMEOUT_MS` | 30000 | Cancela una query que se pasa de este plazo (ms). |

Una caída de conexión a Postgres sale como `503 database_unavailable`
(registrada `warn/domain error`), no como un 500 `internal` — mismo criterio que
Stalwart (#187).
