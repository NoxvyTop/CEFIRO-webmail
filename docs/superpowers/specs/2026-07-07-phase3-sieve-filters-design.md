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
