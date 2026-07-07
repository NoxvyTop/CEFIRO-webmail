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
