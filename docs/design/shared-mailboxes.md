# Diseño — Buzones compartidos y grupales (#13 y #50)

> **Estado: diseño, no implementación.** Este documento consolida el diseño
> diferido del Modelo B (issue **#13**) y el buzón grupal con copia + purga
> (issue **#50**), y deja por escrito las **decisiones que el owner debe tomar
> antes de construir nada**. No se ha tocado código. Reemplaza y actualiza la
> Sección 4 del diseño de Fase 2 (`docs/superpowers/specs/2026-07-06-phase2-admin-portal-design.md`,
> hoy fuera del árbol pero recuperable en `git show b0ea320:...`).

## TL;DR

- **F2 ya entregó el "Modelo A"**: Stalwart entrega una copia del correo grupal
  a la bandeja de cada miembro según la membresía configurada **en Stalwart**;
  el webmail solo la muestra (zona de grupos + toggle en `user_preferences`).
  No hay cuenta central, ni opt-in desde el webmail, ni purga.
- **#50 es un "Modelo A+"**: una cuenta grupal **central** (`copias@`) como
  fuente de verdad, con copia por-usuario **opt-in gestionada por el BFF** vía
  `Email/copy` (JMAP, cross-account), más retención automática y borrado en
  cascada. No hay estado compartido.
- **#13 es el "Modelo B"**: un buzón con credencial propia al que se entra con
  un **selector de cuenta**, más una **capa colaborativa** (estado de lectura
  compartido, asignación, notas internas). El acceso encaja bien en la
  arquitectura actual; la capa colaborativa es lo caro y sigue siendo YAGNI
  hasta que el volumen lo justifique.
- **Recomendación (análisis)**: hacer #50 (por fases, empezando por lo más
  barato y autónomo) y mantener #13 **diferido**. Antes de codear #50 hay que
  resolver un **prerrequisito de infraestructura que hoy NO existe** (cuenta
  grupal + acceso cross-account confirmado).
- **Actualización (spike G-0, 2026-08-03)**: el spike **cerró la duda de fondo,
  confirmado empíricamente end-to-end** — `Email/copy` está implementado y la
  copia grupo→personal **solo necesita la credencial del miembro** (Stalwart
  expone la cuenta grupal en su sesión por Basic vía membresía; se probó con dos
  cuentas reales). El "hueco de viabilidad crítico" de la Sección 3 queda
  **resuelto para la copia**;
  el prerrequisito real que persiste es **aprovisionar** grupos/miembros, que
  exige OAuth admin (`Principal/set` cerrado sobre Basic). Ver "Resultado del
  spike G-0" abajo — **supersede** el análisis de las Secciones 3 y D-50.5.

---

## Decisión del owner (2026-08-03)

El owner quiere **las dos cosas combinadas**, no una u otra:

1. **Acceso** — una zona tipo "céfiro/groups" donde el usuario **ve qué buzones
   compartidos tiene** (`@ventas`, `@copias`, `@soporte`) y **entra** a ellos
   (selector de cuenta). Esto es #13 **sin** la capa colaborativa.
2. **Copia** — y **además** una copia en la bandeja privada de cada usuario
   (opt-in), como en #50.

La capa colaborativa de #13 (asignación, estado de lectura compartido, notas
internas) **sigue diferida** — no forma parte de esta decisión.

**El owner expresó dudas** sobre priorizar copia vs acceso. Por eso el
fraseo por fases de abajo importa: se entrega primero lo barato y probado
(acceso), y la copia entra después. El spike G-0 (abajo) ya cerró la duda de
fondo: **la copia es viable y NO necesita credencial delegada** — basta la
credencial propia del miembro.

**Orden acordado (supera la recomendación de análisis de arriba):**

| Fase | Qué entrega | Riesgo / prerrequisito |
|---|---|---|
| **G-0** ✅ | Spike: `Email/copy` en Stalwart + modelo de credencial. **Cerrado y confirmado empíricamente end-to-end (ver resultado abajo).** | Veredicto: copia **viable** con la credencial del miembro (B y C probados con cuentas reales); el hueco real es el aprovisionamiento (crear grupos/miembros) que exige OAuth admin/UI. |
| **G-1 (acceso)** | Zona de grupos: listar los buzones compartidos del usuario y **entrar** a ellos **con su propia credencial** (Stalwart los expone en la sesión JMAP del miembro). Autorización por petición (403 si no es miembro). | **NO** necesita credencial extra en el BFF: es la del miembro. Sí depende de que la cuenta grupal + membresía existan → aprovisionamiento (ver G-0). Cambio de código: dejar de descartar el mapa `accounts` de la sesión. |
| **G-2 (copia)** | Copia opt-in a la bandeja privada vía `Email/copy` (from grupo → to personal, credencial del miembro) + purga con retención. | Cerrar los 2 chequeos empíricos residuales de G-0 (buzón compartido visible sobre Basic + copia real) y decidir retención/opt-in. La copia cuenta contra la cuota personal del miembro. |
| **(aprovisionamiento)** | Crear grupos y añadir miembros. | **Decisión del owner: SIEMPRE manual en el webadmin de Stalwart (ops), NUNCA desde Céfiro.** `Principal/set` está cerrado sobre Basic/Bearer (`notRequest`), la CLI no tiene subcomando y `/api/*` da 404 → solo la UI OAuth. Automatizar el alta desde el BFF queda **descartado**. El usuario final nunca toca Stalwart; solo el admin/ops. |
| **(diferido)** | Capa colaborativa (#13). | YAGNI hasta que el volumen lo justifique. |

Las decisiones de producto pendientes (retención, direcciones, opt-in por
defecto) siguen abiertas más abajo; se resuelven al entrar en G-2 / G-1.

### Frescura de sesión tras cambios de membresía (decisión 2026-08-03)

Cuando ops añade/quita a un miembro de un grupo en Stalwart, el BFF cachea la
sesión JMAP (`SESSION_CACHE_TTL_MS = 5 min`, `apps/server/src/modules/mail/
context.ts`), así que el buzón compartido no aparece/desaparece hasta que el
BFF **re-pide** la sesión. **Decisión: A + C.** Y una distinción de fondo:
**invalidar la caché de sesión ≠ cerrar la sesión (logout).** Lo que se hace es
invalidar la caché → el usuario **sigue logueado** y en su siguiente request el
BFF re-pide la sesión; NO se fuerza re-login.

- **A (mecanismo normal):** apoyarse en el **TTL de 5 min** que ya existe. Un
  cambio de membresía se refleja en ≤5 min de forma automática, sin código
  nuevo. El acceso no es time-critical, así que basta. (Opcional: bajar el TTL.)
- **C (escape de ops, break-glass):** una acción de admin que **invalida TODAS
  las cachés de sesión** (no logout) para que todos re-pidan la sesión en su
  siguiente request. Útil tras reorganizar grupos en bloque. Se apoya en
  `evictMailSession(userId)` (hoy dropea caché + cierra streams del usuario);
  nota de implementación: para un "refrescar solo la sesión" sin cortar el SSE
  haría falta una variante que no cierre streams, o se acepta que el SSE
  reconecta.
- **Descartado / diferido:** forzar logout por cambio de grupo (disruptivo, no
  hace falta); botón de refresco por usuario (B, diferido); vigilar
  `sessionState` para propagación instantánea (D, diferido — además habría que
  confirmar con 1 curl que Stalwart bumpea `sessionState` al cambiar membresía).

### Resultado del spike G-0 (2026-08-03)

Ejecutado contra el Stalwart v0.16.12 de la demo. **Veredicto: la copia es
viable — CONFIRMADO EMPÍRICAMENTE end-to-end** (método `Email/copy`, acceso del
miembro a la cuenta compartida por Basic, y copia real grupo→personal). Detalle:

- **`Email/copy` está implementado** (confirmado empíricamente). Una copia
  a la misma cuenta devuelve `invalidArguments "From accountId is equal to
  fromAccountId"` — un error del *handler*, no `unknownMethod` (se verificó con
  un método falso `Foo/bar` que sí da `unknownMethod`). El método parsea
  `fromAccountId`/`accountId` y exige que sean **distintos**: la copia es
  cross-account por diseño.
- **Modelo de credencial (lo importante):** son DOS cosas distintas, no
  mezclarlas:
  - *Copia en runtime (acción del usuario):* **solo la credencial propia del
    miembro.** Stalwart expone la cuenta grupal como cuenta compartida en la
    sesión JMAP del miembro (vía membresía), así que un único `Email/copy`
    (`fromAccountId`=grupo, `accountId`=miembro) autenticado como el miembro
    basta. **Sin credencial delegada, sin admin, sin descargar-y-resubir.** (No
    se puede usar una "credencial del grupo": los principals de grupo no pueden
    hacer login.)
  - *Aprovisionar (crear grupo, añadir miembros):* **requiere OAuth admin.**
    `Principal/set` sobre HTTP Basic devuelve `notRequest`; solo funciona con un
    Bearer de sesión de gestión. El REST viejo `/api/principal` ya no existe en
    v0.16. La credencial Basic del BFF **no** puede aprovisionar.
- **Acceso = membresía**, no ACL por buzón: se accede al inbox del grupo por
  `members`/`memberOf`. El source de Stalwart re-sincroniza la lista de cuentas
  compartidas en la sesión (`synchronize_mailboxes()`), así que el BFF debe
  **re-pedir la sesión** del miembro tras un cambio de share (hoy la cachea).
- **Chequeos B y C — CONFIRMADOS empíricamente end-to-end (2026-08-03).** Se
  crearon dos cuentas desechables (`ventas@` tipo grupo + `member@` individual)
  y se añadió `member@` como miembro del grupo:
  - **(B)** La sesión JMAP de `member@` **autenticado por HTTP Basic** lista
    **dos** cuentas: la personal (`isPersonal:true`) y `ventas@`
    (`isPersonal:false`). El miembro puede `Mailbox/get`/`Email/query` contra la
    cuenta del grupo. → El acceso funciona con la credencial propia del miembro.
  - **(C)** Con la credencial Basic del miembro, un único `Email/copy`
    (`fromAccountId`=ventas, `accountId`=member, `onSuccessDestroyOriginal:false`)
    copió un correo del grupo a su inbox personal: aterrizó en el inbox del
    miembro y el original quedó intacto en `ventas`. → La copia grupo→personal
    es real y solo necesita la credencial del miembro.
- **Nota de aprovisionamiento (confirmada en la práctica):** crear esas cuentas
  NO se pudo por shell (`Principal/set` devuelve `notRequest` con Basic y con
  Bearer; la CLI no tiene subcomando de cuentas; `/api/*` da 404). Hubo que
  crearlas por la **UI del webadmin** (sesión OAuth). Confirma que el
  aprovisionamiento es el único paso que exige gestión OAuth/UI.
- **Caveats de producción:** la copia cuenta contra la **cuota personal** del
  miembro (los blobs se deduplican por contenido, la metadata no); poner
  `keywords`/`mailboxIds` explícitos en el `create` si se quieren conservar
  flags; para compartir a nivel más fino que "todo el inbox del grupo" haría
  falta el camino ACL/`shareWith`, no la membresía.

---

## Diseño concreto de G-1 (acceso) y G-2 (copia) — 2026-08-03

### G-1 · Acceso a buzones compartidos

**Backend**

1. **Exponer el mapa `accounts`.** `getSession` (`apps/server/src/infra/jmap/
   client.ts`) hoy solo lee `primaryAccounts[mail]` y **descarta** el resto.
   Añadir a `JmapSession` un `accounts: Array<{id, name, isPersonal}>`.
   `accountId` sigue siendo la personal (back-compat).
2. **Endpoint `GET /api/mail/shared-accounts`.** Devuelve las cuentas
   **no-personales** (los buzones compartidos accesibles) leyendo la sesión
   **cacheada** — sin llamada JMAP extra.
3. **Parametrizar el `accountId`.** Hoy **~20 sitios** en `mail/router.ts` fijan
   `session.accountId`, más los builders de URL de blobs (descarga/subida).
   Introducir un helper `resolveAccountId(session, requested)`:
   `undefined` → personal; `requested ∈ session.accounts` → lo devuelve; si no →
   **403 `account_forbidden`**. El `accountId` llega por query param
   (`?accountId=`). Sustituir `session.accountId` por el helper en cada ruta y en
   los builders de blob URL.
4. **Autorización.** El 403 del BFF es defensa en profundidad: Stalwart YA
   impide que un miembro vea cuentas de las que no es miembro (su sesión solo
   lista las suyas). El BFF valida contra `session.accounts` para un error limpio
   y no filtrar ids.
5. **SSE.** La EventSource de JMAP empuja `StateChange` de **todas** las cuentas
   de la sesión (incl. compartidas), así que el tap existente ya recibe eventos
   del buzón compartido. *A revisar en impl:* que el harvesting/notif no asuma el
   accountId personal.

**Frontend — fork de UX (decisión del owner)**

- **Opción 1 · Selector de cuenta (recomendada MVP):** un chip/dropdown en la
  cabecera que cambia TODA la vista al buzón compartido (como el selector de
  Gmail). Modelo mental claro, un buzón a la vez, poco estado nuevo (el
  `accountId` entra en las claves de TanStack Query).
- **Opción 2 · Sidebar unificado:** los buzones compartidos como secciones extra
  en la barra lateral, bajo los personales. Todo a la vista pero más estado y más
  riesgo de mezclar contextos.
- **Recomendación:** Opción 1 para el MVP; Opción 2 diferida.

### G-2 · Copia a la bandeja privada

**Fork que cambia el modelo — ¿copia Céfiro o Stalwart nativamente?**

- **Modelo NATIVO — CONFIRMADO NO DISPONIBLE (2026-08-03).** La idea era
  configurar el grupo para que el correo cayera en el buzón compartido **Y** se
  copiara a cada miembro (entrega dual). **Stalwart v0.16 no lo hace hoy:**
  - *Empírico:* en el spike, el correo a `ventas@` cayó **solo** en el buzón del
    grupo; la bandeja de `member@` quedó vacía hasta el `Email/copy`.
  - *Docs:* un `group` = buzón compartido (acceso); una `mailing list` = copias a
    miembros **sin** buzón compartido. Ningún principal hace las dos.
  - *Comunidad:* "dar al grupo la opción de copiar a cada miembro" está **en
    discusión, sin implementar** (stalwart discussion #2931).
  - *Alternativa native-ish descartada:* un Sieve `redirect :copy` en el buzón del
    grupo copiaría a cada miembro conservando el buzón, pero **no da opt-in por
    miembro** (habría que editar el script por cada alta/baja) y re-inyecta el
    correo. No encaja con el opt-in que se quiere.
  → Por tanto, la copia debe ir por el **modelo APP**.
- **Modelo APP / `Email/copy` (probado en el spike):** Céfiro copia con la
  credencial del **miembro**. Necesario si Stalwart no hace la entrega dual, o
  para **opt-in por miembro** (la expansión MTA es todo-o-nada por config del
  grupo) y para copias **retroactivas/selectivas**.

**El PUSH/daemon del diseño original (F2: suscripción al EventSource del grupo +
credencial potente del grupo) quedó DESCARTADO en 2026-08-03:** el spike
demostró que no hace falta credencial del grupo; si Céfiro copia, lo hace con la
del miembro (PULL).

> **Reabierto en #313 (entrega automática).** El argumento en contra del daemon
> era la **credencial del grupo**: una credencial más potente que la de
> cualquier miembro, custodiada por el BFF y con radio de impacto sobre todos
> los buzones. Ese argumento no aplica al diseño que se entregó: la suscripción
> al EventSource del buzón compartido la abre el BFF con la credencial de **un
> miembro con opt-in** (el "watcher", elegido y re-elegido en cada ciclo entre
> los miembros que alcanzan la cuenta), exactamente la misma credencial y la
> misma sesión que ese miembro usa desde su navegador en `GET /api/mail/events`.
> En el proceso no existe nada más potente que un miembro, y las copias siguen
> haciéndose una a una con la credencial del miembro destinatario. Lo que se
> mantiene del análisis original es la mitigación del riesgo "suscripción
> huérfana" (sección 6): la suscripción tiene su propio watchdog de silencio
> (90 s) y reconexión con backoff, pero **no** se registra en `mailStreams`
> (`streams.ts`), porque ese registro está indexado por usuario y se cierra en
> el logout del usuario — y el logout de un miembro no debe apagar el buzón
> para los demás. Detalle en `apps/server/src/modules/mail/shared-copy/` y en
> `docs/ARCHITECTURE.md` ("Copias automáticas de buzones compartidos").

**Sub-fork del modelo APP (cuándo copia):**
- **Manual (primer slice, entregado en G-2):** el miembro pulsa "copiar a mi
  bandeja" en un mensaje del grupo. Trivial, el miembro controla, sin job de
  fondo. Sigue existiendo: sirve para el correo **anterior** al opt-in, que la
  entrega automática no toca.
- **Automático de fondo — ENTREGADO en #313.** Un worker del BFF sigue cada
  buzón compartido con opt-ins mediante un **cursor** sobre `Email/changes`
  (estado JMAP persistido en `shared_mailbox_copy_state`) y copia cada mensaje
  nuevo de la **bandeja de entrada** del buzón a cada miembro con opt-in, con
  la credencial cifrada de ese miembro y el mismo `Email/copy` del botón manual.
  Un libro de copias (`shared_mailbox_copies`, clave miembro+cuenta+mensaje)
  impide duplicados si una página se repite tras una caída. **Disparador
  híbrido (decisión del owner):** (1) la suscripción EventSource descrita
  arriba lanza un ciclo en cuanto cambia el estado `Email` de la cuenta
  compartida; (2) un sondeo pasivo cada `SHARED_MAILBOX_COPY_POLL_MS` (5 min
  por defecto) corre el ciclo para cada buzón como red de seguridad. Un sondeo
  puro se descartó por latencia; un push puro, por lo que pierde en una
  reconexión o con una réplica caída. **`PushSubscription` de JMAP (RFC 8620
  §7.2, webhook real desde el proveedor) queda como opción futura**: eliminaría
  el socket sostenido, pero exige un endpoint HTTPS entrante alcanzable desde
  el proveedor y su handshake de verificación. Sin backfill: el opt-in es hacia
  adelante (el primer ciclo solo fija el cursor, y a cada miembro nuevo lo
  registra su primer ciclo sin copiarle nada), y el correo previo se copia a
  mano. Al desactivar la opción, el worker borra en el siguiente sondeo —no en
  el siguiente ciclo, que un buzón sin miembros ya no tiene— el registro del
  miembro y las copias que le quedaban pendientes o fallidas de ese buzón,
  conservando las ya entregadas como historial anti-duplicado; volver a
  activarla lo registra de nuevo, sin rellenar el hueco.
- **Alcance exacto de "correo nuevo" (#313).** Se entregan **solo** los ids que
  `Email/changes` marca como `created`, y la pertenencia a la bandeja se
  evalúa **cuando corre el ciclo**. Dos consecuencias buscadas: un mensaje que
  llega a otra carpeta y **se mueve después** a la bandeja compartida no se
  copia (para el proveedor es `updated`, no `created`), y un mensaje creado en
  la bandeja que se **mueve o se borra antes** de que corra el ciclo tampoco
  (ya no está ahí cuando se filtra). Tratar `updated` como entregable haría
  que cada marca de leído, cada etiqueta y cada movimiento dentro del buzón
  compartido dispararan copias, y separar "movido a la bandeja" de "marcado
  como leído" exigiría recordar el estado anterior de cada mensaje en un
  segundo libro. Los dos casos los cubre el botón manual **"copiar a mi
  bandeja"**, que no depende ni del cursor ni del momento de llegada.

**Decisiones de producto (owner) — recomendaciones**
- **Opt-in:** toggle por buzón compartido, **default OFF** (opt-in explícito).
- **Retención / cascada:** **sin borrado en cascada en el MVP.** La copia es
  correo del propio miembro en su propia bandeja; él la gestiona. La purga con
  retención (F1) aplica solo al buzón del grupo, si acaso. El F3 (cascada) queda
  diferido.
- **Direcciones:** qué buzones activan copia se decide **por buzón**, no global.
- **Caveats del spike:** la copia cuenta contra la **cuota personal** del miembro;
  poner `keywords`/`mailboxIds` explícitos para conservar flags.

**Decisión (2026-08-03): modelo APP.** Confirmado que el nativo no está
disponible, G-2 va por `Email/copy` con la credencial del miembro. **Primer
slice = copia manual** ("copiar a mi bandeja"); el automático de fondo, solo si
se pide después — **se pidió y se entregó en #313** (ver el sub-fork arriba).
Opt-in por buzón (default OFF), sin cascada en el MVP. La retención y la purga
de las copias siguen fuera de alcance.

---

## 1. Los dos modelos, lado a lado

| | **F2 Modelo A** (ya hecho) | **#50 Modelo A+** (grupal con copia) | **#13 Modelo B** (compartido + colaborativo) |
|---|---|---|---|
| Cuenta propia del buzón | No | **Sí** (`copias@`, fuente de verdad) | **Sí** (`info@`, con credencial) |
| Quién reparte la copia | Stalwart (membresía) | **El BFF** (`Email/copy` JMAP) | No hay copia; se entra a la cuenta |
| Opt-in desde el webmail | No (siempre llega) | **Sí** (toggle por usuario) | N/A |
| Estado compartido / asignación / notas | No | No | **Sí** (lo distintivo) |
| Archivo único / historial central | No | Sí (la cuenta central) | Sí (la cuenta compartida) |
| Retención + purga en cascada | No | **Sí** | No (fuera de alcance) |
| Encaje con la arquitectura actual | Total | **Parcial** (cross-account es nuevo) | Bueno para el acceso; caro el colaborativo |

**La diferencia de fondo entre #50 y #13:**

- **#50** reparte **copias** a la bandeja personal de cada miembro (patrón
  Gmail Groups). Cada quien lee en su propio buzón, con su propia credencial.
  La cuenta central existe sobre todo como fuente de verdad para la copia y
  para la purga en cascada.
- **#13** NO reparte copias: los miembros **entran** a un buzón que no es el
  suyo (selector de cuenta) y colaboran sobre **el mismo** correo (ver que otro
  ya contestó, asignarse conversaciones, dejar notas internas). Es el patrón
  helpdesk (Front, Zendesk, bandeja colaborativa de Workspace).

---

## 2. Qué se reutiliza y qué es genuinamente nuevo

### 2.1 Lo que YA existe y se reutiliza (F1/F2)

| Pieza reutilizable | Dónde | Sirve para |
|---|---|---|
| Cifrado de credenciales + keyring (AES-GCM, rotación) | `apps/server/src/modules/credentials/crypto.ts` (`encryptWithKeyring`, `decryptWithKeyring`, `asKeyring`) | Guardar la credencial del buzón grupal/compartido con la MISMA mecánica que la de un usuario |
| Proxy JMAP genérico | `apps/server/src/infra/jmap/client.ts` (`request(auth, session, calls, extraUsing)`) | Ejecutar cualquier método JMAP (incluye `Email/copy`, `Email/query`, `Email/set destroy`) contra una credencial dada |
| Tap del EventSource | `apps/server/src/modules/mail/contacts-harvest-stream.ts` (`tapEmailStateChanges`, `emailStateFromFrame`) | Detectar "llegó correo nuevo" a partir del `StateChange` de `Email` |
| Bookkeeping de streams | `apps/server/src/modules/mail/streams.ts` (`mailStreams`, watchdog de silencio) | Ciclo de vida de conexiones largas |
| Selector "enviar como" (identidades F1) | `mail/router.ts` `GET /identities` + `lookupComposeContext` | Componer/enviar como la dirección del buzón (compartido o de empresa) |
| Preferencias por usuario | `apps/server/src/infra/repos/user-preferences.ts` (ya tiene `groupMailInMainInbox`) | Guardar el opt-in de copia por grupo sin tocar Stalwart |
| Destroy con confirmación | `mail/router.ts` (`Email/set { destroy }`, verifica `destroyed[]`) | Base de la purga |

### 2.2 Lo genuinamente NUEVO por issue

**#50 (Modelo A+):**
- **Almacén de credencial del buzón grupal** (tabla nueva; ver §3).
- **Suscripción persistente al EventSource de la cuenta grupal** — el tap
  actual (`GET /events`, `mail/router.ts:557`) corre **por pestaña de un
  usuario logueado** y muere cuando cierra el navegador. #50 necesita una
  suscripción **de fondo, propia del servidor**, autenticada con la credencial
  del grupo, viva aunque ningún miembro tenga el webmail abierto. Reutiliza el
  **mecanismo** (`tapEmailStateChanges`), pero el **ciclo de vida es nuevo**.
- **`Email/copy` cross-account** — no existe **ninguna** llamada `Email/copy`
  en el repo, y el modelo de sesión es de **una cuenta por credencial** (ver
  §3, "hueco de viabilidad"). Código nuevo, y con un supuesto que hay que
  validar.
- **Opt-in por usuario y por grupo** (preferencia nueva o tabla `group_subscriptions`).
- **Script de retención + cascada** (cron/systemd) — no hay ninguna infra de
  purga/cron hoy.

**#13 (Modelo B):**
- **Tablas `shared_mailboxes` (credencial cifrada) y `shared_mailbox_access`
  (mapeo buzón↔usuario).**
- **Selector de cuenta** en la barra lateral (UI nueva).
- **Autorización server-side por petición** (403 si la sesión no está en
  `shared_mailbox_access`). Encaja como una variante de `requireMail`
  (`mail/context.ts`) que resuelve **otra** credencial en vez de la del usuario.
- **Capa colaborativa** (lo caro): estado de lectura compartido, asignación de
  conversaciones, notas internas → tablas + endpoints + UI + sincronización en
  tiempo real. Es lo que #13 pide diferir hasta que el volumen lo justifique.

---

## 3. Prerrequisitos de infraestructura (lo que HOY no existe)

> Estas tres cosas son **bloqueantes** para #50 (y para el acceso de #13). Sin
> ellas no hay nada que construir en el BFF.

1. **La cuenta grupal/compartida debe existir en Stalwart, con su propia
   credencial.** Stalwart es la fuente de verdad. No la crea el webmail; la
   crea el admin en Stalwart. **El fixture e2e no tiene ninguna cuenta así hoy**
   (`e2e/fixtures/mail.ts`, `e2e/jmap-admin.ts` solo crean cuentas de usuario) —
   habrá que añadirla para poder testear.

2. **El BFF debe guardar esa credencial, cifrada.** La tabla actual
   `mail_credentials` está **PK por `user_id`** (una fila por usuario,
   `ON DELETE CASCADE`), así que **no puede** alojar una credencial que no sea
   de un usuario. Hace falta **una tabla nueva** — se reutiliza el cifrado
   (`crypto.ts`), no el esquema:

   | Tabla (nueva) | Columnas mínimas |
   |---|---|
   | `shared_mailboxes` / `group_mailboxes` | `id`, `display_name`, `address`, `ciphertext`, `iv`, `key_version`, timestamps |
   | `shared_mailbox_access` (#13) o `group_subscriptions` (#50) | `mailbox_id`, `user_id`, (#50: `copy_optin boolean`) |

3. **Confirmar el acceso cross-account de JMAP — HUECO DE VIABILIDAD (crítico
   para #50).** Hoy `getSession` toma **una** cuenta:
   `primaryAccounts["urn:ietf:params:jmap:mail"]` (`client.ts:317`), y cada
   credencial ve solo su propia cuenta. `Email/copy` (RFC 8621 §4.7) lleva
   `fromAccountId` y `accountId` y exige que **la credencial autenticada tenga
   acceso a AMBAS cuentas**. En el modelo actual, ninguna credencial de usuario
   ve la cuenta grupal y viceversa. Es decir:
   - El proxy JMAP **técnicamente puede emitir** un `Email/copy` (la regex
     `MUTATING_METHOD` en `client.ts:97` ya lo contempla), pero **no hay quién
     lo llame** y, sobre todo, **no hay una credencial con acceso a las dos
     cuentas**.
   - Para copiar `grupo → miembro` haría falta **una credencial con acceso
     cross-account** (admin/superusuario de Stalwart, o delegación explícita
     configurada en Stalwart). Eso **aún no está validado** contra este
     despliegue y **aumenta el radio de impacto** (ver §6).
   - **Acción previa a codear #50: un spike** que pruebe `Email/copy` entre dos
     cuentas reales de Stalwart y determine qué credencial/permiso lo habilita.
     Si Stalwart no lo soporta con una credencial acotada, cambia la
     arquitectura de #50 (ver decisión D-cross en §4).

---

## 4. Decisiones que debe tomar el OWNER

> Cada una lleva **recomendación** y **tradeoff**. No las decido yo: son
> producto/operación/legal.

### #50 — buzón grupal con copia + purga

**D-50.1 · ¿Qué dirección(es)?**
- **Recomendación:** empezar con **una sola** (p. ej. `copias@`).
- **Tradeoff:** cada cuenta grupal añade una suscripción persistente, una
  credencial que custodiar y más radio de impacto. Varias direcciones
  multiplican todo eso; conviene probar el patrón con una.

**D-50.2 · Ventana de retención X (días).**
- **Recomendación:** fijar un default explícito (sugerencia neutra: **30 días**
  para adjuntos) pero **la decide el owner** (criterio legal/operativo, no
  técnico).
- **Tradeoff:** X más corto = menos disco y menos exposición de adjuntos, pero
  riesgo de perder algo que se necesitaba; X más largo = más almacenamiento y
  más ventana para que un cliente offline cachee copias antes de la purga.

**D-50.3 · Mecanismo/UI del opt-in.**
- **Recomendación:** toggle por usuario en la zona de grupos, reutilizando el
  patrón de `user_preferences`; **default = desactivado** (no llueven copias a
  quien no las pidió).
- **Tradeoff:** default off respeta la bandeja del usuario pero exige que cada
  quien active; default on garantiza que nadie se pierda correo pero llena
  bandejas sin consentimiento y agranda el alcance del borrado en cascada.

**D-50.4 · ¿Se acepta el "sin rastro" con la limitación de clientes offline?**
- **Contexto:** el borrado es **server-side**. Si un miembro ya sincronizó el
  correo en un cliente offline (Outlook, móvil IMAP) antes de la purga, esa
  copia local **no desaparece**. "Sin rastro" solo se garantiza en el servidor.
- **Recomendación:** aceptar la garantía "solo servidor", **documentarla** y
  fijar expectativas con los miembros.
- **Tradeoff:** si "sin rastro en ningún sitio" es un requisito duro (legal),
  #50 **no puede cumplirlo distribuyendo copias**. En ese caso: no repartir
  copias (mantener solo la cuenta central, sin notificación por copia) — lo que
  acerca la solución al **acceso** de #13 sin capa colaborativa.

**D-50.5 · ¿Se acepta que el BFF tenga una credencial con acceso cross-account?**
- **RESUELTA por el spike G-0 (2026-08-03): ya NO aplica para la copia.** La
  copia en runtime la hace **la credencial propia del miembro** (Stalwart expone
  la cuenta grupal en su sesión vía membresía); el BFF **no** necesita una
  credencial potente cross-account. La pregunta que sí queda es la del
  **aprovisionamiento**: crear grupos/miembros exige un token OAuth admin, no la
  credencial Basic del BFF — decisión trasladada a la fase de aprovisionamiento
  (manual en el webadmin para el MVP vs. automatizar en el BFF).
- *(Contexto histórico, superado)* La cascada de borrado (F3/#50) sí escribiría
  en la bandeja del miembro; con el modelo de membresía eso también recae en la
  credencial del miembro, no en una super-credencial del BFF.
- **Tradeoff:** habilita #50 tal cual está escrito, pero concentra en el BFF
  una credencial capaz de tocar todos los buzones (radio de impacto alto). Si
  no se acepta, hay que rediseñar #50 (p. ej. acceso en vez de copia).

### #13 — buzón compartido colaborativo

**D-13.1 · ¿Se quiere de verdad la capa colaborativa (asignación, estado de
lectura compartido, notas internas), o el Modelo A/#50 cubre la necesidad real?**
- **Recomendación:** **mantener #13 diferido** (YAGNI, como dice el propio
  issue) hasta que el volumen demuestre que el Modelo A/#50 se queda corto
  (correos que se caen o respuestas duplicadas).
- **Tradeoff:** construir la capa colaborativa ahora es el trozo más caro
  (tablas + endpoints + UI + sincronización en tiempo real del estado
  compartido) y, si el volumen no lo pide, es esfuerzo sin demanda.

**D-13.2 · ¿El volumen actual justifica el Modelo B?**
- **Recomendación:** esta la responde el owner con datos de volumen reales (yo
  no los tengo). El disparador que fijó F2 es: *"cuando se caigan correos o se
  dupliquen respuestas con el Modelo A"*.
- **Tradeoff:** adelantarse = complejidad prematura; quedarse corto = fricción
  operativa (respuestas dobles) que el equipo empieza a sentir.

### Transversal

**D-X.1 · ¿#50 solo satisface la necesidad y #13 queda diferido?**
- **Recomendación:** **sí.** #50 (aunque sea una fase de #50) entrega el valor
  con mucho menos coste y riesgo que la capa colaborativa. #13 espera al
  disparador de volumen.
- **Tradeoff:** si el flujo real es "varias personas trabajando **el mismo**
  hilo en paralelo" (soporte tipo helpdesk), la notificación por copia no
  coordina (dos pueden contestar) y ahí sí pesa #13.

**D-X.2 · ¿Copia (Gmail Groups) o acceso (abrir el buzón compartido)?**
- **Contexto:** es una bifurcación real. La **copia** (#50) mete el correo en
  la bandeja de cada uno; el **acceso** (parte de #13, sin capa colaborativa)
  hace que los miembros **abran** la cuenta compartida con un selector.
- **Recomendación:** si lo que se quiere es "que todos vean lo que llega a
  `copias@`", el **acceso** es más barato y encaja **mejor** con la
  arquitectura actual (una credencial = una cuenta; sin cross-account, sin
  suscripción de fondo, sin cascada). La **copia** solo se justifica si además
  se necesita retención con borrado en cascada (que es justo lo que #50 pide).
- **Tradeoff:** acceso = los miembros tienen que ir a una carpeta/cuenta aparte
  (no "cae en mi bandeja"); copia = experiencia Gmail Groups pero arrastra todo
  el aparato cross-account + cascada.

---

## 5. Fase recomendada y primer slice

Recomendación: **hacer #50 por fases, #13 diferido.** Orden por dependencia y
por relación valor/riesgo:

| Fase | Qué entrega | Depende de | Coste/riesgo |
|---|---|---|---|
| **F0 — Prerrequisito (sin código de app)** | Cuenta grupal en Stalwart + credencial en el BFF + **spike** cross-account + añadir la cuenta al fixture e2e | — | Bajo, pero **bloqueante** |
| **F1 — Retención (primer slice recomendado)** | Script (cron/systemd) scopeado a la cuenta grupal: `Email/query { hasAttachment, before X }` → `Email/set { destroy }` → purga de blobs por CLI | F0 | **Bajo**: autónomo, una sola cuenta, sin cross-account, sin UI. Valor inmediato (disco/cumplimiento) |
| **F2 — Notificación por copia** | Suscripción persistente al EventSource del grupo + `Email/copy` a cada miembro con opt-in | F0 + spike OK (D-50.5) | **Alto**: infra nueva (daemon) + cross-account + credencial potente |
| **F3 — Borrado en cascada** | Extender la purga: por cada mensaje purgado en el grupo, buscar por `Message-ID` en las cuentas de los miembros y destruir; disparar purga de blobs | F2 (las copias deben existir) | Medio-alto: vuelve a necesitar cross-account |
| **#13 — Modelo B colaborativo** | Selector de cuenta + authz + capa colaborativa | Disparador de volumen | **Muy alto** — **diferido** |

**Primer slice más pequeño que entrega valor: F1 (la retención).** Es
autónomo, no toca cross-account, no necesita UI ni suscripción de fondo, y
resuelve por sí solo el "adjuntos que se acumulan" con el menor riesgo. Si tras
el spike (F0) el cross-account resulta inviable o inaceptable (D-50.5), F1
**igual queda entregado** y se replantea F2/F3.

> Nota de honestidad: **F2 es el valor "Gmail Groups" que motiva #50**, pero es
> también la parte cara y arriesgada. Si el owner elige **acceso** en vez de
> copia (D-X.2), F2/F3 se sustituyen por el "acceso al buzón compartido" (la
> parte de #13 **sin** capa colaborativa), que encaja mejor con el modelo
> actual de una-credencial-una-cuenta.

---

## 6. Riesgos

| Riesgo | Detalle | Mitigación |
|---|---|---|
| **"Sin rastro" no es total** | El borrado es server-side; un cliente offline (Outlook/IMAP) que ya cacheó la copia la conserva. | Documentar la garantía como "solo servidor" (D-50.4); si se necesita más, no distribuir copias. |
| **Radio de impacto de la credencial cross-account** | Copia y cascada exigen que el BFF tenga una credencial capaz de escribir/borrar en la bandeja de **cada** miembro. Si se filtra, expone todos los buzones. | Spike de menor privilegio; custodia cifrada (keyring); acotar y auditar cada uso; decisión explícita D-50.5. |
| **La purga toca la retención global** | `DataRetention` de Stalwart es **server-wide**; usarlo purgaría todo, no solo el grupo. | El script debe operar **por JMAP scopeado a la cuenta grupal** (`Email/query` con su `accountId`), **nunca** tocar `DataRetention`. Test que verifique el scope. |
| **Cascada por `Message-ID` frágil si cambia el header** | La cascada matchea por `Message-ID`; solo se preserva porque la copia es `Email/copy` (JMAP), no reenvío SMTP. | Prohibir cualquier ruta de copia vía SMTP/forward para este flujo; test que confirme `Message-ID` idéntico tras `Email/copy`. |
| **Authz del buzón compartido (#13)** | Un usuario no autorizado no debe poder abrir `info@`. | Verificación server-side en **cada** petición contra `shared_mailbox_access`; 403 si no está. Nunca confiar en el frontend (variante de `requireMail`, `mail/context.ts`). |
| **Suscripción persistente huérfana (#50 F2)** | El daemon que escucha el EventSource del grupo puede colgarse (Stalwart deja de pinguear) o duplicarse. | Entregado en #313 (`shared-copy/watcher.ts`): watchdog de silencio propio de 90 s (mismo presupuesto que `streams.ts`, pero **fuera** de `mailStreams` porque ese registro se cierra con el logout del usuario), reconexión con backoff exponencial 5 s → 60 s, una suscripción por cuenta y por réplica. Con varias réplicas las suscripciones se duplican a propósito; la entrega la serializa el arrendamiento (lease) por cuenta del ciclo, y el libro de copias impide duplicados. |
| **Purga de blobs prematura** | Disparar la purga de blobs por CLI antes de destruir todas las referencias libera disco pero puede dejar huérfanos. | Destruir **todas** las referencias (grupo + copias) y confirmar `destroyed[]` antes de la purga de blobs. |

---

## 7. Referencias de código

- Credenciales + cifrado: `apps/server/src/infra/repos/mail-credentials.ts`,
  `apps/server/src/modules/credentials/crypto.ts`.
- Cliente JMAP (sesión de una cuenta, proxy genérico): `apps/server/src/infra/jmap/client.ts`.
- Rutas de correo (identidades, `/events`, destroy, send): `apps/server/src/modules/mail/router.ts`.
- Tap del EventSource: `apps/server/src/modules/mail/contacts-harvest-stream.ts`.
- Ciclo de vida de streams: `apps/server/src/modules/mail/streams.ts`.
- Authz por petición: `apps/server/src/modules/mail/context.ts` (`requireMail`, `evictMailSession`).
- Preferencias por usuario (toggle grupal): `apps/server/src/infra/repos/user-preferences.ts`.
- Fixture e2e (hoy sin cuenta grupal): `e2e/fixtures/mail.ts`, `e2e/jmap-admin.ts`.
- Diseño F2 original (recuperable): `git show b0ea320:docs/superpowers/specs/2026-07-06-phase2-admin-portal-design.md` (Secciones 4 y 5).
