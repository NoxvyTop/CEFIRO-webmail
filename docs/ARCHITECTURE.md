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

   El adaptador (`infra/jmap/`) habla **JMAP (RFC 8620/8621) a secas**, no
   Stalwart (#33): el proveedor se configura por rol con `JMAP_URL`, las URLs
   que anuncia en su sesión se resuelven según `JMAP_URL_MODE`
   (`rewrite` por defecto, `trust` para host partido — #34) y la credencial se
   presenta según `JMAP_AUTH_MODE` (`basic` o `bearer` para proveedores con
   token — #35). Como el navegador nunca consume esas URLs anunciadas, el BFF
   puede reescribirlas al camino directo sin que nada más se entere. Ver la
   matriz de topologías en [OPERATIONS.md](OPERATIONS.md).

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

### Rotación de la clave maestra

Cada fila cifrada guarda en `key_version` la versión de la clave con la que se
selló. El servidor no maneja una clave sino un llavero: la clave actual, que es
la única que cifra, más las claves retiradas que todavía hacen falta para leer
filas que aún no se han vuelto a cifrar.

| Variable | Contenido |
| --- | --- |
| `MASTER_KEY` | clave actual, base64 de 32 bytes (44 caracteres) |
| `MASTER_KEY_VERSION` | versión que se estampa al cifrar; por defecto `1` |
| `MASTER_KEY_PREVIOUS` | claves retiradas como `version:base64key`, separadas por comas |

Un despliegue que solo define `MASTER_KEY` sigue funcionando sin cambios: es la
versión 1 sin historial, que es justo lo que el esquema pone por defecto en
todas las columnas `key_version`.

#### La clave se genera, nunca se copia (#223)

```sh
bun apps/server/scripts/generate-master-key.ts
```

Esa es la **única** forma admitida de obtener un `MASTER_KEY`. La clave que
trae `docker-compose.dev.yml` es literalmente `dev-master-key-dev-master-key-01`
en base64: existe para que el entorno de desarrollo arranque sin ceremonia y es
pública, porque está en el repositorio. Copiada a producción descifra todas las
credenciales de buzón y el client secret de SSO.

Antes solo se validaba la **longitud** de la clave, así que esa copia pasaba sin
una queja. Ahora el arranque rechaza claves publicadas en el repositorio y
claves de baja entropía (todos los bytes iguales, muy pocos valores distintos, o
enteramente ASCII imprimible — es decir, una frase escrita a mano en vez de 32
bytes generados).

La comprobación **no se aplica cuando `NODE_ENV` es `development` o `test`**, y
sí en cualquier otro valor (`production`, `staging`, `preproduc`, o el nombre
que se invente el despliegue). Es una lista de permitidos, no de prohibidos:
para saltarse la validación hay que declarar explícitamente que el entorno no es
real. El compose de desarrollo y la suite de tests siguen funcionando sin tocar
nada.

Las claves retiradas de `MASTER_KEY_PREVIOUS` **no** se validan: sirven para
leer filas selladas antes de una rotación, así que rechazarlas dejaría sin
arrancar justo al despliegue que está rotando *para salir* de una clave débil.
Ese es el camino de salida si alguna instancia arrancó con la clave de
desarrollo: rotar (la nueva clave generada pasa a `MASTER_KEY`, la débil queda
listada en `MASTER_KEY_PREVIOUS`) y esperar a que el re-cifrado progresivo mueva
todas las filas antes de retirarla.

Dos garantías sostienen el diseño: en el arranque el servidor comprueba que el
llavero cubre todas las `key_version` presentes en `mail_credentials`,
`sso_config` e `integrations` y **no arranca** si falta alguna; y las filas se
vuelven a cifrar solas al leerlas con una clave retirada, de forma best-effort,
porque el correo del usuario no puede depender de esa reescritura.

Mientras queden filas en la versión antigua, su clave debe seguir listada: es
lo que evita que una rotación deje credenciales indescifrables.

El **procedimiento de rotación** —paso a paso, con las consultas para saber
cuándo se puede retirar una clave y su interacción con los backups— es
operación, no diseño, y vive en el runbook:
[OPERATIONS.md → Rotación de `MASTER_KEY`](OPERATIONS.md#rotación-de-master_key).

### Configuración OIDC administrable

La configuración del proveedor SSO (issuer, client_id, client_secret,
scopes) vive en la base de datos y se edita desde el portal de
administración, no en variables de entorno. Esto permite reconfigurar
Authentik o migrar a otro proveedor OIDC sin tocar código ni redesplegar.
En el entorno solo quedan secretos de infraestructura: clave maestra de
cifrado y conexión a Postgres.

### Modo bootstrap / recuperación

Al estilo Stalwart, `BOOTSTRAP_MODE=true` en el entorno cumple dos roles:

- **Primer arranque**: la aplicación inicia en modo configuración con un
  usuario administrador temporal cuya contraseña **fija quien despliega** en
  `BOOTSTRAP_PASSWORD` (#235). Con esa cuenta se configura el administrador
  real, el proveedor OIDC y las credenciales de buzón iniciales desde una
  pantalla mínima de setup.
- **Recuperación**: si una configuración OIDC defectuosa deja a todos sin
  acceso, se activa el modo, se entra por el login de emergencia, se corrige la
  configuración desde el portal de administración y se vuelve a producción.

La credencial no la genera ni la registra el proceso. Antes se inventaba al
arrancar y se escribía en claro en el log, que es el sitio de un contenedor con
más lectores y más retención; pedírsela al operador borra el problema de
entrega en vez de moverlo, y la deja en el mismo gestor de secretos que
`MASTER_KEY` — que es la frontera de confianza que le corresponde, porque
concede acceso de administración.

La bandera de entorno no es la única compuerta del setup: `/api/setup` se cierra
por sí mismo en cuanto el setup está terminado —existe un administrador activo y
SSO configurado— aunque `BOOTSTRAP_MODE` siga puesto (#234). El estado se lee de
la base de datos, no de una columna que alguien marque, así que sobrevive a un
reinicio, a un redespliegue y a un rollback sin nada que migrar. Es la
recuperación la que cambia de puerta: a partir de ahí se entra por el login de
emergencia y se corrige en el portal de administración, no en el asistente.

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
└── infra/              # adaptadores: Postgres, cliente JMAP (infra/jmap/), cliente Authentik
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
| `integrations` | integraciones externas: tipo (ej. odoo-calendar), config (JSON), secretos cifrados, activada sí/no |
| `sent_recipients` | direcciones a las que el usuario ha escrito (nivel "remitente conocido" del indicador de confianza, #314); separada de `contacts` a propósito |
| `shared_mailbox_copy_state` | cursor de las copias automáticas de buzones compartidos (#313): último estado `Email` JMAP procesado (nulo = nunca fijado) y el arrendamiento de entrega por cuenta (`lease_owner`, `lease_until`), una fila por cuenta compartida |
| `shared_mailbox_copies` | libro de copias entregadas (#313): (miembro, cuenta compartida, mensaje origen), lo que impide duplicados al repetir una página |

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

### Indicador de confianza del remitente (#314)

Sobre la insignia de autenticidad (#136/#152: veredicto DMARC `pass`/`fail`/
`unknown` leído de `Authentication-Results`, ver `docs/OPERATIONS.md`), el
lector muestra un segundo nivel **solo positivo** (`senderTrust`), calculado en
`GET /api/mail/threads/:id` por `modules/mail/sender-trust.ts`:

| Nivel | Condición |
|-------|-----------|
| `known` (remitente conocido) | DMARC `pass` **y** la dirección `From` exacta es una a la que el usuario ha escrito antes (`sent_recipients`). |
| `trusted-service` (servicio de confianza) | DMARC `pass` **y** el dominio del `From` está en la lista de servicios de confianza, o es subdominio de una entrada (`noreply.github.com` cae bajo `github.com`). |
| `none` | Cualquier otro caso. No es un aviso: es la ausencia de afirmación. |

Si aplican los dos, gana `trusted-service`. Reglas que no se negocian:

- **DMARC `pass` es la puerta.** Sin él no hay nivel, aunque la dirección sea
  conocida o el dominio esté en la lista: un `fail` sigue siendo la única señal
  negativa y nunca se contradice con una marca positiva. Un `pass` solo, sin
  coincidencia, tampoco da confianza. No se parsea DKIM `d=`: DMARC ya exige
  alineación con el dominio del `From` (RFC 7489 §6.6.2).
- **El `pass` debe estar ligado a la dirección que se muestra.** Un `dmarc=pass`
  es evidencia sobre el dominio que DMARC evaluó, no sobre cualquier dirección
  del mensaje: `deriveSenderAuthFacts` lee el propspec `header.from=` del
  `dmarc=` de esa misma cabecera de confianza y el nivel solo se asigna si ese
  dominio coincide exactamente con el de `from[0]`. Además el mensaje debe
  llevar **una sola** dirección en `From` (RFC 5322 permite varias y DMARC
  evalúa una); con varias, cuál ve el lector es un accidente de representación
  y no se afirma ningún nivel. Sin `header.from=` legible, o con dos entradas
  `dmarc=` que nombran dominios distintos, el resultado es `none`.
- **La interfaz muestra siempre la dirección o el dominio real** junto a la
  insignia (`SenderTrustBadge`, con el `from[0]` que devuelve el servidor en
  su nombre accesible), para que el lector compruebe a quién se avala.
- **"Está en contactos" no es señal.** `contacts` se alimenta de cada remitente
  que llega (#124/#180), así que un phisher ganaría una fila con solo enviar.
  `sent_recipients` registra únicamente la dirección **saliente**: envíos
  confirmados por `POST /send`, los mensajes que aparecen en *Enviados* en la
  cosecha de llegada, y un backfill único y acotado (200 mensajes más
  recientes de *Enviados*) la primera vez que un usuario abre un hilo.
- **Coincidencia de dominio por etiquetas**, en minúsculas: `githiib.com` o
  `notgithub.com` nunca coinciden con `github.com`; `com` tampoco.

La lista de servicios de confianza es la unión de una **semilla curada**
(`apps/server/src/modules/mail/trusted-services-seed.ts`: grandes proveedores
cuyo correo transaccional es objetivo habitual de phishing y que publican DMARC
en modo estricto; inmutable y no editable por usuario) y los dominios que el
usuario confirma desde el lector ("Confiar en {dominio}", solo ofrecido con
DMARC `pass`), guardados en `user_preferences.preferences.trustedServices` y
gestionados por `GET/PUT/DELETE /api/mail/trusted-services[/:dominio]`.
Quitar una entrada de la semilla responde `409 trusted_service_seed`; añadir
una entrada nueva cuando la lista del usuario ya tiene 200 responde
`409 trusted_services_limit` (volver a confiar una ya presente sigue siendo
`200`).

No es BIMI: no se consulta DNS del remitente ni se descarga ningún logotipo;
la marca es un icono fijo junto al dominio real. No requiere variables de
entorno nuevas; sin `JMAP_AUTHSERV_ID` todo queda en `none`, igual que la
insignia de autenticidad queda en `unknown`.

### Copias automáticas de buzones compartidos (#313)

Un miembro de un buzón compartido puede pedir, desde Ajustes → Buzones
compartidos, que el correo nuevo de ese buzón le llegue también a su propia
bandeja (`user_preferences.preferences.sharedMailboxCopyOptIn`). Desde #313 el
servidor actúa sobre esa preferencia con **el único trabajo de fondo que tiene
este proceso**: `apps/server/src/modules/mail/shared-copy/`. Es el mismo
`Email/copy` del botón manual "copiar a mi bandeja" (`shared-copy/copy.ts`, con
la credencial del miembro destinatario), ejecutado sin que nadie pulse nada.
El diseño y las alternativas descartadas están en
`docs/design/shared-mailboxes.md` (G-2); aquí va cómo funciona.

**Ciclo de entrega** (`delivery.ts`, uno por cuenta compartida):

1. **Elegir un watcher.** No existe credencial del grupo (un principal de grupo
   no puede iniciar sesión), así que la cuenta compartida se lee a través de la
   sesión de un miembro: el primero de los miembros con opt-in (orden por
   email) cuya sesión JMAP alcanza la cuenta. Se re-elige en cada ciclo; un
   miembro dado de baja o con credencial revocada solo cuesta una línea de
   log. Sin candidato, el ciclo no toca nada.
2. **Cursor.** El servidor guarda el último estado `Email` de la cuenta
   compartida que procesó (`shared_mailbox_copy_state`). Sin fila, el primer
   ciclo **solo fija el estado actual, sin copiar**: el opt-in es hacia
   adelante, y el correo anterior sigue disponible con el botón manual. Con
   fila, pide `Email/changes { sinceState, maxChanges: 100 }` y recorre como
   mucho cinco páginas por ciclo; lo que quede lo termina el siguiente. Si el
   proveedor responde `cannotCalculateChanges` (el cursor es más viejo que su
   historial), se vuelve a fijar el estado y se avisa en el log: el correo de
   ese hueco es incognoscible, y un barrido "los N más recientes" repartiría
   duplicados. Cualquier otro error del proveedor se propaga **sin mover el
   cursor**, para reintentar la misma página en el siguiente sondeo o push.
3. **Solo bandeja de entrada.** Un lote de lectura (`Mailbox/query role=inbox`
   + `Email/get mailboxIds`) sobre la cuenta compartida filtra los ids creados:
   lo enviado por el grupo, los borradores y lo archivado por una regla Sieve
   no es "correo nuevo del buzón".
4. **Copiar a cada miembro**, con la sesión de cada uno (un miembro cuya sesión
   ya no lista la cuenta se salta con log). Antes de cada copia se consulta el
   libro `shared_mailbox_copies` en una sola query por página; después de cada
   copia confirmada (`created`, nunca por ausencia de `notCreated`) se escribe
   la fila. Un fallo en la copia de un miembro se cuenta, se registra y **no
   bloquea a los demás**.
5. **Avanzar el cursor** al `newState` de la página **después** de sus copias.
   Una caída entre la última copia y el avance repite la página en el ciclo
   siguiente, y el libro convierte la repetición en saltos, no en duplicados.
   El cursor avanza aunque la copia de un miembro haya fallado: lo que protege
   la copia de ese miembro entre ciclos es el libro, y clavar una página por el
   fallo de uno dejaría sin correo a todos.

**Disparador híbrido** (`worker.ts` + `watcher.ts`, decisión del owner): por
cada cuenta con opt-ins el servidor mantiene **una suscripción EventSource**
propia (`{types}=Email`, `{closeafter}=no`, `{ping}=30`) abierta con la
credencial del watcher, y un cambio del estado `Email` de la cuenta lanza un
ciclo al momento. Como red de seguridad, un **sondeo pasivo** cada
`SHARED_MAILBOX_COPY_POLL_MS` (5 min) vuelve a listar los opt-ins, corre el
ciclo de cada cuenta y reconcilia las suscripciones (abre las de cuentas
nuevas, cierra las que ya nadie pide). Los pushes de una misma cuenta se
pliegan en un solo ciclo en vuelo más, como mucho, uno de seguimiento. La
suscripción tiene watchdog de silencio de 90 s y reconexión con backoff
exponencial (5 s → 60 s), y **no** se registra en `mailStreams`: ese registro
es por usuario, tiene tope de 8 y se cierra con el logout del usuario, y el
logout de un miembro no debe apagar el buzón para los demás. Una credencial
rotada o revocada aparece como 401 en la siguiente conexión o elección, y se
elige a otro miembro. `PushSubscription` de JMAP (webhook real) queda como
opción futura: quitaría el socket sostenido a cambio de un endpoint HTTPS
entrante y su handshake.

**Varias réplicas.** Cada réplica mantiene sus propias suscripciones y su
propio sondeo, a propósito: la duplicación de suscripciones es barata y evita
coordinar quién escucha. Lo que **no** se duplica es la entrega: cada ciclo
toma un **arrendamiento (lease) por cuenta** en la propia fila de estado
(`lease_owner`, `lease_until`), y quien no lo consigue cede sin esperar — el
poseedor está haciendo el mismo trabajo. El titular es un `crypto.randomUUID()`
por proceso, así que cada réplica es un titular distinto. Se toma con un único
`insert … on conflict do update … where` atómico (el `where` corre bajo el
bloqueo de fila del insert, así que dos réplicas compitiendo se serializan y
solo una recibe fila), se renueva tras cada página y se libera en el `finally`;
si el titular muere a medio ciclo, la cuenta se recupera sola al vencer
`lease_until` (TTL de 10 min). **Ninguna transacción abarca el ciclo**: el
advisory lock anterior mantenía una conexión del pool dentro de una transacción
durante todo el ciclo mientras cada query de ese mismo ciclo pedía otra
conexión al mismo pool — bloqueo mutuo garantizado con `DB_POOL_MAX=1` y una
conexión *idle in transaction* de minutos en cualquier otro caso, además de
posibles colisiones de `hashtext` entre cuentas distintas.

**Arranque y apagado.** El worker se construye solo con `JMAP_URL` configurado
y `SHARED_MAILBOX_COPY_ENABLED` no desactivado, arranca **después** de que el
listener esté escuchando, y sin opt-ins no corre ciclos ni abre suscripciones.
En el apagado ordenado (#193) se detiene **antes** de drenar el listener
(`createShutdown.stopWorkers`) para que ningún ciclo empiece una copia contra
un pool que se está cerrando. Las dos fases comparten **un solo plazo**,
`SHUTDOWN_GRACE_MS`: lo que tarde en pararse el worker se descuenta del
drenaje, con un suelo de 1 s (`MIN_DRAIN_MS`), de modo que la espera hasta el
cierre forzado nunca es el doble del plazo configurado. Cada copia intentada
suma en `cefiro_shared_mailbox_copies_total{result}`.

**Fuera de alcance, a propósito:** retención o purga de las copias, borrado en
cascada, backfill del correo anterior al opt-in y la UI más allá del texto de
ayuda.

### Papelera con retención

La regla de borrado tras X días la ejecuta Stalwart. En F1 se configura
directamente en Stalwart; desde F2 el plazo se definirá en el portal de
administración vía la API de Stalwart.

## Configurador de integraciones

El portal de administración incluye un configurador de integraciones
externas. Cada integración se registra con:

- **Tipo**: qué conecta (ej. `odoo-calendar`, `odoo-tasks`; extensible a
  futuros proveedores).
- **Configuración**: URL del servidor, base de datos, credenciales de
  servicio (cifradas con la misma clave maestra).
- **Estado**: activada o desactivada por el administrador.

Las integraciones activadas aparecen como módulos en la zona de módulos de
la barra lateral de los empleados. Activar el calendario de Odoo, por
ejemplo, hace visible el módulo Calendario sin redesplegar la aplicación.

En el backend, cada integración es un adaptador detrás de un puerto común
(patrón ya definido en la arquitectura hexagonal): agregar un proveedor
nuevo es escribir un adaptador, no tocar el núcleo.

El configurador llega con el portal de administración (F2); los primeros
adaptadores de Odoo llegan en F4.

## Manejo de errores y observabilidad

- **Errores tipados en el dominio**: los adaptadores traducen cada fallo
  externo (Stalwart caído, Authentik sin respuesta, error JMAP) a un error de
  dominio conocido.
- **Sobre de error uniforme** hacia el SPA: `{ code, message, traceId }`,
  donde `message` es una clave i18n.
- **traceId de punta a punta**: cada petición lleva un identificador que la
  sigue por SPA → BFF → Stalwart y aparece en todos los logs relacionados.
- **Logs estructurados** (JSON), filtrables por usuario, ruta y traceId.
  Ninguna credencial aparece jamás en logs. El traceId viaja en un contexto
  asíncrono (`core/logger.ts`), así que las líneas de diagnóstico profundas
  —deadline saliente, sincronización Sieve, cosecha de contactos, adaptador de
  IA— se correlacionan sin arrastrar un logger por cada firma. `LOG_LEVEL`
  (`debug`|`info`|`warn`|`error`, por defecto `info`) filtra la salida.
- **Frontend resiliente**: reintentos con backoff para fallos transitorios;
  si Stalwart no responde, banner de desconexión manteniendo visible el
  contenido cacheado.
- **Health checks**: `/api/health` reporta el estado de Postgres y Stalwart
  (sonda JMAP acotada por el deadline saliente) y devuelve **503** cuando algún
  chequeo falla, para que un balanceador/orquestador saque de rotación una
  instancia degradada. Authentik (OIDC) no se sondea en cada poll a propósito:
  su `discover()` es una llamada saliente al IdP y golpearla en cada health
  reintroduciría el vector de amplificación que cierra #194. Los chequeos
  corren **en paralelo** y con presupuesto propio (`core/health.ts`), muy por
  debajo del `--timeout=5s` del `HEALTHCHECK` del contenedor, y su resultado se
  **cachea unos segundos**: N sondeos no son N llamadas salientes a Stalwart.
  El endpoint es anónimo, así que además lleva límite de tasa por origen.
- **Métricas**: `/metrics` expone en formato Prometheus los contadores de
  petición por ruta/método/estado, la latencia como histograma y el estado de
  cada dependencia, reutilizando la sonda de salud ya cacheada en vez de añadir
  llamadas salientes. Es superficie de operador, no del SPA: se abre con un
  token portador (`METRICS_TOKEN`) y sin él el endpoint no existe. Procedimiento
  y reglas de alerta en [OPERATIONS.md](OPERATIONS.md#métricas-y-alertas).

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

### Migraciones de esquema (#207)

Las migraciones corren **en el arranque** del propio servidor
(`apps/server/src/index.ts` → `infra/db/migrate.ts`), no como paso separado
del despliegue: un contenedor que arranca deja la base al día por sí solo.

Todo el runner va dentro de una transacción que sostiene un **advisory lock**
(`pg_advisory_xact_lock`). Sin él, dos réplicas que arrancan a la vez pasaban
ambas la comprobación `select 1 from schema_migrations`, ejecutaban el mismo
DDL y la perdedora moría — un crash loop, porque cada reinicio repite la
carrera. Con el lock una réplica migra y las demás esperan; cuando entran,
todas las migraciones ya constan aplicadas. Es la variante *xact* del lock
porque se libera tanto al confirmar como al abortar: una réplica que muere a
mitad no puede dejar el lock tomado y bloquear a las demás.

Consecuencia de diseño: como el runner corre dentro de una transacción, una
migración **no puede usar sentencias no transaccionales** (`CREATE INDEX
CONCURRENTLY`, `VACUUM`). Ya era así antes de #207 — cada archivo se aplicaba
dentro de su propia transacción — pero conviene tenerlo escrito.

#### Reversibilidad: solo cambios compatibles hacia atrás

**No hay down-migrations, y es una decisión deliberada.** El rollback de #190
vuelve a una imagen exacta, es decir revierte el *código*; el esquema no
vuelve solo, y una down-migration que borre una columna o una tabla destruye
datos justo en el momento en que el sistema ya está en incidente. La red de
seguridad real del esquema es el backup (`scripts/db-restore.sh`), no un
script inverso.

Por eso la regla es que **toda migración debe ser compatible con la imagen
anterior**: la versión N-1 del código tiene que seguir funcionando contra el
esquema de la versión N. En la práctica:

- Añadir columnas siempre como nullable o con `default`; nunca `not null` sin
  default en una tabla con filas.
- Añadir tablas, índices y columnas es libre. **Borrar y renombrar no**: se
  hace en dos despliegues (expandir → migrar datos y dejar de usar el campo →
  contraer en un despliegue posterior, cuando ya no queda código que lo lea).
- Cambiar el tipo de una columna se trata como borrar + añadir.
- Nada de DML destructivo dentro de una migración.

Deshacer un cambio de esquema es, entonces, **otra migración hacia delante**
(o una restauración de backup si ya hubo pérdida de datos), nunca un rollback
de esquema. Un cambio que no se pueda expresar de forma compatible hacia atrás
necesita ventana de mantenimiento explícita y backup previo verificado.

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

### IA — funciones opt-in (resumen y redacción asistida)

Las funciones de IA (resumen de correos, "Redactar con IA") están **apagadas
por defecto e inertes sin configuración explícita**. Esto es lo único que el
software de CEFIRO-webmail asume o promete al respecto:

- `AI_ENABLED` (booleano, por defecto `false`) y `AI_API_KEY` (secreto) deben
  estar ambos presentes para que el proveedor se active; si falta cualquiera
  de los dos, cualquier llamada a resumir/redactar falla rápido con un error
  de dominio (`ai_disabled`) **sin intentar ninguna petición de red**, ni al
  proveedor de IA ni a Stalwart.
- `AI_PROVIDER` (por defecto `anthropic`) y `AI_MODEL` (por defecto
  `claude-opus-4-8`) son configurables por variable de entorno — no hay
  modelo ni proveedor hardcodeado.
- El contenido del correo nunca se registra en logs. Solo se envía al
  proveedor el mínimo contenido necesario para la llamada (cuerpo del mensaje
  para resumir; asunto y contexto opcional para redactar) — nunca el buzón
  completo ni datos no relacionados.

Cualquier restricción adicional a nivel de red (por ejemplo, limitar el
egress del contenedor hacia el proveedor de IA) es una decisión de
**despliegue**, específica de cada instalación — no algo que esta aplicación
imponga o de lo que dependa. Ese tipo de defensa en profundidad vive en el
repositorio de despliegue de quien autoaloja el software, fuera del contrato
de esta base de código.

## Fases de entrega

| Fase | Alcance | Estado |
|------|---------|--------|
| F1 — Correo | Leer, redactar, responder, adjuntos con previsualización, carpetas, búsqueda, firmas, etiquetas, identidades múltiples (enviar como / recibido en), notificaciones, papelera con retención, login SSO, bootstrap/recuperación | ✅ Completa |
| F2 — Administración | Portal admin (`/admin`): provisioning JIT en el primer login SSO, gestión de usuarios (credencial de buzón, rol, archivado con revocación de sesiones), config OIDC administrable; login doble (SSO + puerta de emergencia bootstrap); correos grupales (Modelo A: copia a la bandeja, zona de grupos, toggle de bandeja unificada) | ✅ Completa |
| F3 — Organización | Filtros/reglas (UI de Sieve), respuestas automáticas | ✅ Completa |
| F4 — Suite Odoo | Calendario embebido, módulo de tareas, configurables por el admin | Pendiente |

Cada fase llega a `main` funcionando.

La Fase 1 (núcleo de correo) está completa de punta a punta: autenticación
SSO con bootstrap/recuperación, lectura (carpetas, lista virtualizada,
hilos con HTML sanitizado, búsqueda, etiquetas, notificaciones en tiempo
real por SSO/SSE), y redacción (composer con editor enriquecido, responder
y responder a todos, identidades, firmas, adjuntos con subida y descarga,
envío por JMAP EmailSubmission). Se entregó en cuatro planes
(fundación, autenticación, lectura, redacción) sobre la base de Stalwart.

La Fase 2 (administración) está completa: provisioning JIT de usuarios en el
primer login SSO, portal de administración en `/admin` (gestión de usuarios,
credenciales de buzón, roles, archivado con revocación inmediata de
sesiones, configuración OIDC administrable), login con doble entrada (SSO +
puerta de emergencia bootstrap solo visible en modo bootstrap), y correos
grupales (Modelo A: el correo grupal llega copiado a la bandeja del miembro,
zona de grupos derivada de las identidades, y toggle por usuario de bandeja
unificada). El buzón compartido con credencial y bandeja colaborativa
(Modelo B) queda diferido (issue #13). El webmail no escribe en Authentik ni
en Stalwart: consume identidades/membresías que el admin configura allí.

## Flujo de ramas

`init-desarollo` (desarrollo) → `preproduc` (testing) → `main` (producción).
