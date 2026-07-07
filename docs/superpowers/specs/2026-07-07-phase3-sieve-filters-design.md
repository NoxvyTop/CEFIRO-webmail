# Diseño — Fase 3: Filtros (Sieve) y respuestas automáticas

> Documento vivo. Se completa por secciones durante el brainstorming de F3.
> Diseño de alto nivel en `docs/ARCHITECTURE.md` (F3). Acá se resuelven las
> mecánicas de integración con Stalwart.

## Alcance de la Fase 3

- Filtros/reglas de correo con un constructor estructurado (estilo Gmail):
  condiciones + acciones, sin editar Sieve a mano.
- Respuestas automáticas de vacaciones.
- Reenvío manual de un correo (acción puntual en el composer).

Fuera de alcance de F3:

- **Modo avanzado / editor de Sieve crudo** (Opción C): diferido al issue
  #23. Se retoma cuando un power user necesite reglas que el constructor no
  cubra.
- **Regla de auto-reenvío / redirect** (Sieve `redirect`): excluida a
  propósito por política de empresa — es el vector nº1 de fuga de
  información. Las respuestas automáticas cubren el caso "estoy de
  vacaciones, escribí a soporte@".

## Decisiones clave (resueltas en brainstorming)

- **Gestión de Sieve por JMAP (RFC 9661), NO ManageSieve.** Se reusa el
  cliente JMAP de F1 + la credencial de buzón cifrada, agregando la
  capacidad `urn:ietf:params:jmap:sieve` al `using`. JMAP for Sieve viene
  habilitado por defecto en Stalwart y funciona en la Community Edition
  (verificado). Sin puerto 4190 expuesto, sin superficie de red nueva —
  todo por el canal interno del correo. Más seguro.
- **Postgres es la fuente de verdad; el script Sieve es derivado.** El
  usuario edita reglas estructuradas; el webmail genera el script y lo sube.
- **El webmail gestiona un único script por usuario** (greenfield: no pisa
  nada previo).

## Sección 1: Arquitectura y modelo de sincronización

```
UI rule builder ──reglas estructuradas──▶ PostgreSQL (fuente de verdad)
                                               │ en cada cambio
                                          Generador Sieve (función pura)
                                               │ reglas → script
                                          JMAP SieveScript/set + activate
                                               │
                                          Stalwart (ejecuta server-side)
```

Principios:

1. **Postgres = fuente de verdad; el script Sieve = artefacto derivado.** El
   usuario nunca toca el script a mano.
2. **El generador es una función pura** `(reglas, vacaciones) → string
   Sieve`: sin I/O, determinista, la pieza más testeada.
3. **En cada cambio se regenera el script COMPLETO y se re-sube** por JMAP
   (`SieveScript/set` sobre el script gestionado por el webmail + activarlo;
   `SieveScript/validate` antes de activar).
4. **Reusa el cliente JMAP de F1**: capacidad `urn:ietf:params:jmap:sieve`,
   misma credencial cifrada, mismo canal interno. Cero red nueva.
5. **Greenfield**: el webmail es dueño del único script por usuario.

Filtros y vacaciones viven en el **mismo script generado** (la respuesta de
vacaciones es una acción `vacation` de Sieve). Un script, una activación.

## Sección 2: Modelo de datos de las reglas

**Tabla `filter_rules`** (una fila por regla, por usuario):

| Columna | Qué guarda |
|---------|-----------|
| `id`, `user_id` | identidad y dueño (ownership en SQL, como firmas) |
| `position` | orden de evaluación (las reglas se aplican en orden) |
| `name` | nombre visible ("Facturas a carpeta Contabilidad") |
| `match_type` | `all` / `any` (¿todas las condiciones o alguna?) |
| `conditions` | JSONB: array de condiciones |
| `actions` | JSONB: array de acciones |
| `enabled` | activar/desactivar sin borrar |

**Condición** (JSONB): `{ "field": "from"|"to"|"subject"|"body", "op":
"contains"|"is", "value": string }`. `from` = remitente; `to` = para-o-cc
combinados; `subject`/`body` = texto.

**Acción** (JSONB): `{ "type": "fileinto", "folder": string }` (mover a
carpeta) · `{ "type": "seen" }` (marcar leído) · `{ "type": "flag",
"keyword": string }` (destacar/etiquetar) · `{ "type": "delete" }` (a la
papelera) · `{ "type": "stop" }` (detener reglas siguientes).

**Por qué JSONB y no tablas separadas**: condiciones y acciones son un array
flexible que siempre se lee/escribe junto con su regla; su forma la valida
Zod en `packages/shared`. Normalizarlas sería sobre-diseño. Una fila = una
regla completa.

**Validación en dos capas**: Zod valida la forma antes de guardar; el
generador + `SieveScript/validate` de Stalwart validan el Sieve resultante
antes de activarlo.

**Carpetas para `fileinto`**: se eligen de la lista de buzones reales que ya
trae JMAP (F1) — desplegable, nunca texto libre.

## Sección 3: Respuestas automáticas de vacaciones

Un panel en `/settings` (junto a las firmas), no una "regla" más.

**Tabla `vacation_settings`** (una fila por usuario):

| Columna | Qué guarda |
|---------|-----------|
| `user_id` | dueño (pk) |
| `enabled` | on/off |
| `subject` | asunto opcional (vacío = comportamiento estándar de `vacation`) |
| `message` | texto de la respuesta ("Estoy de vacaciones, escribí a soporte@…") |
| `starts_at`, `ends_at` | rango de fechas opcional (null = sin límite) |
| `interval_days` | no responder al mismo remitente más de una vez cada N días (default 7) |

**Traducción a Sieve**: acción `vacation` con `:days N` y `:subject`
opcional. El rango de fechas se genera como condición `currentdate`
alrededor de la acción — el encendido/apagado por fechas lo ejecuta Stalwart
solo (se programa el viernes, se activa solo el lunes).

**Buenas prácticas que el generador aplica siempre** (no configurables):

- Solo responde si la dirección del usuario está en Para/Cc (evita responder
  a listas y spam masivo — comportamiento por defecto de `vacation`).
- No responde a correos auto-generados (el estándar evita bucles de
  auto-respuesta).
- `interval_days` evita bombardear a un mismo remitente.

**Orden en el script generado**: primero los filtros, después `vacation` al
final. Una regla con "eliminar + detener" evita la auto-respuesta para ese
correo. Coherente y predecible.

## Sección 4: Reenvío manual, endpoints y testing

### Reenvío manual (composer)

Acción "Reenviar" por correo en el panel de lectura, junto a
Responder/Responder a todos. Abre el composer con: destinatarios vacíos,
asunto `Fwd: <original>` (sin duplicar prefijo), cuerpo citado sanitizado
(mismo `sanitizeEmailHtml` del reply) con línea de atribución, y **los
adjuntos del original reutilizando sus blobIds** (JMAP permite adjuntar por
blobId sin re-subir). Es una acción deliberada por correo — distinta y no
afectada por la exclusión de la regla de auto-reenvío.

### Endpoints (BFF)

| Endpoint | Guard | Qué hace |
|----------|-------|----------|
| `GET/POST /api/mail/filters`, `PUT/DELETE /api/mail/filters/:id`, `PUT /api/mail/filters/order` | sesión | CRUD de reglas + reordenar (ownership en SQL) |
| `GET/PUT /api/mail/vacation` | sesión | leer/guardar la config de vacaciones |
| (interno) sync | — | tras cada mutación: regenerar script → `SieveScript/validate` → `SieveScript/set` + activar, vía JMAP con la credencial del usuario |

La sincronización es parte de la mutación: si la subida a Stalwart falla, la
mutación responde con un error claro (`sieve_sync_failed`) y la UI lo
muestra — el usuario sabe que su regla quedó guardada pero pendiente de
aplicar, con opción de reintentar (botón "Reaplicar filtros").

El CRUD funciona sin Stalwart configurado (se guarda en Postgres; la
sincronización se hace cuando haya conexión de correo), igual que firmas.

### Manejo de errores

- Regla inválida (forma) → 400 `invalid_body` (Zod, antes de tocar nada).
- Script rechazado por `SieveScript/validate` → `sieve_invalid` (no debería
  pasar — el generador solo emite formas válidas; si pasa, es bug nuestro y
  el error lo dice).
- Stalwart inaccesible al sincronizar → `sieve_sync_failed` + botón
  reintentar. Las reglas quedan en Postgres, nada se pierde.

### Testing

1. **Generador Sieve (lo más denso)**: función pura — cada tipo de
   condición/acción, combinadores all/any, orden por `position`, reglas
   deshabilitadas excluidas, escape de strings (comillas, backslashes,
   contenido malicioso en `value` NO puede romper/inyectar Sieve),
   vacation con y sin fechas, script vacío (sin reglas ni vacation).
2. **Integración**: CRUD con ownership (un usuario no toca reglas de otro),
   sync llama SieveScript/set con el script generado (JMAP stubbeado),
   fallo de sync → error correcto sin perder la regla.
3. **UI**: rule builder (agregar condición/acción, guardar), panel de
   vacaciones, botón Reenviar prellena el composer.

La **inyección de Sieve** es el riesgo de seguridad específico de F3: un
`value` con comillas/saltos podría intentar escapar del string Sieve. El
generador escapa TODO valor de usuario y los tests lo atacan explícitamente.

## Descomposición en planes de implementación

1. **Plan 1 — Núcleo Sieve (servidor)**: migración (filter_rules,
   vacation_settings), generador Sieve (función pura), capacidad JMAP sieve
   + SieveScript métodos en el cliente, endpoints CRUD + vacation + sync.
2. **Plan 2 — UI de filtros y vacaciones**: rule builder en /settings,
   panel de vacaciones, estados de error/reintento.
3. **Plan 3 — Reenvío manual + verificación**: acción Forward en el
   composer (blobIds reutilizados), barrido final, marcar F3 completa.
