# Hoja de ruta a producción

Estado y plan de endurecimiento de CEFIRO-webmail para llevarlo a producción sin
riesgo de mala reputación. Nace de una auditoría de cinco dimensiones con
evidencia `file:line`, y se reescribe cuando una ola se cierra y la siguiente
auditoría la sustituye.

> **Esto es el plan, no el procedimiento.** Cómo se despliega, se promueve, se
> revierte, se diagnostica y se recupera está en [OPERATIONS.md](OPERATIONS.md),
> que es la fuente de verdad para operar. Si este documento y el runbook llegaran
> a contradecirse, **manda el runbook** — y la contradicción es un bug de esta
> página.

## Dónde estamos

Las olas **8, 9 y 10 están cerradas**. Son las que trajeron la red de seguridad
operativa que el runbook documenta hoy: copia de emergencia, rollback por imagen
inmutable, monitoreo y apagado ordenado. La auditoría inicial situaba el conjunto
en ~73% con la dimensión de operaciones en 62% y sin backup/DR ni rollback; eso
ya no describe este repositorio.

| Dimensión | Lectura de hoy |
|---|---|
| Seguridad y privacidad | Sigue sin hallazgo crítico ni de fuga: cifrado en reposo con rotación, sesiones hasheadas, correo en iframe sandbox, SQL parametrizado. Cerrados el rate limit del login y la cuota de IA (#194), el techo de cuerpo (#195), las cookies `Secure` en producción (#196) y la calidad exigida a `MASTER_KEY` (#223). Lo que queda es abuso y superficie residual: #234, #238, #239. |
| Testing / CI | Compuertas de lint (#198) y de cobertura (#199), esta última por archivo (#228) y extendida a `packages/shared` (#229). La imagen que se publica ya se arranca y se escanea antes de salir (#244, #260). Queda subir los umbrales a la realidad medida (#245), quitar los reintentos que disfrazan tests inestables (#246) y tapar los huecos de e2e (#247, #248). |
| Frontend / diseño / a11y | El móvil ya no está roto: navegación alcanzable en pantallas estrechas (#177), navegación de Ajustes y Admin sin desbordes (#226) y decisión de estrategia tomada (#202). Queda accesibilidad (#251, #252, #253) y los desbordes que siguen a 375px (#249, #250). |
| Fiabilidad / observabilidad | Postgres acotado con timeouts y pool (#191), apagado ordenado (#193), health que cubre Stalwart y devuelve 503 degradado (#197), `traceId` en todo el diagnóstico y `LOG_LEVEL` (#219), métricas y alertas (#208). Queda ampliar las métricas más allá del HTTP de entrada (#240) y cerrar el ciclo de vida del SSE (#241, #243). |
| **Operaciones / despliegue — 86%** | dbSOS diaria cifrada, verificada y con estado monitorizable (#189, #208), imagen inmutable con rollback (#190), scripts de recuperación dentro de la imagen (#256), arranque que falla con un mensaje accionable en vez de un stack trace (#257) y procedimiento de promoción escrito (#262). Queda **ensayar una restauración de verdad** (#258): la copia está verificada, pero verificar no es ensayar. |

## Lo que ya está bien y no hay que perder de vista

Rotación de `MASTER_KEY` con guarda de arranque (#172), timeouts salientes
(#165), Stalwart caído → 502 (#187), píxel de rastreo por `<style>` cerrado
(#182), cabecera de auth falsificada ignorada (#136), rate limit del login de
emergencia (#183). El Sieve no expone `redirect`/`forward`, así que no hay vector
de exfiltración de correo.

## Las olas cerradas

Se dejan escritas porque son el índice de por qué el sistema es como es hoy; cada
número lleva a la discusión completa.

| Ola | Qué trajo |
|---|---|
| **8 — Operabilidad para lanzar** | dbSOS y restauración (#189), imagen inmutable por SHA/semver y rollback (#190), Postgres acotado y su caída → 503 (#191), confirmación de `EmailSubmission` en el envío (#192), apagado ordenado (#193). |
| **9 — Abuso, límites y compuertas** | Rate limit en `/login` y cuota de IA (#194), `bodyLimit` global (#195), cookies `Secure` forzadas en producción (#196), health con Stalwart + `HEALTHCHECK` (#197), compuerta de lint (#198), compuerta de cobertura (#199). |
| **10 — Pulido y accesibilidad** | A11y del shell (#200), code splitting por ruta (#201), paginación del listado de usuarios de admin (#153). |

## La ola en curso — auditoría post-v10

La auditoría que siguió a la ola 10 abrió una tanda nueva (#231-#262). Agrupada
por dónde duele:

- **Operaciones:** #256, #257, #258, #259, #260, #261, #262.
- **Testing / CI:** #244, #245, #246, #247, #248.
- **Seguridad:** #234, #235, #238, #239.
- **Fiabilidad:** #236, #237, #240, #241, #242, #243.
- **Frontend / a11y:** #249, #250, #251, #252, #253, #254, #255.

## Backups — las dos capas

No dependemos de una sola, y cubren cosas distintas:

1. **dbSOS, dentro del stack de Céfiro** (#189, ya en marcha): `pg_dump` cifrado
   diario, con retención, verificación de cada archivo y un fichero de estado que
   Prometheus vigila (#208). Es la red **rápida**: recupera en minutos. La clave
   no vive junto al backup, y un dump restaurado solo es descifrable con el
   llavero de `MASTER_KEY` vigente al restaurar (#172). Procedimiento completo en
   [OPERATIONS.md → dbSOS](OPERATIONS.md#dbsos--copia-de-emergencia-de-la-base-de-datos).
2. **Backup externo por ARGOS** (infraestructura, fuera de este repo): backup de
   todos los contenedores hacia un bucket **Backblaze B2**. Cubre el nivel de
   infraestructura y es más lento; la dbSOS no lo sustituye, lo complementa.

Pendiente y consciente: nadie ha ensayado todavía una restauración completa
(#258). Un backup verificado que nunca se restauró sigue siendo una hipótesis.

## Estrategia móvil — decidida (#202)

Se tomó el camino A: **responsividad de la web actual**, que es lo que cerró #177
y dejó la navegación alcanzable en pantallas estrechas. La app nativa
multiplataforma (#185) queda como opción de largo plazo, no como deuda: si algún
día se aborda, la web responsive sigue siendo el webmail de escritorio y el
fallback.

## Conexión Céfiro↔Stalwart (#188)

Resuelta y documentada: la conexión es una sola (JMAP sobre `STALWART_URL`; el
navegador nunca toca Stalwart), con la topología de contenedores en la misma red.
Ver [ARCHITECTURE.md](ARCHITECTURE.md).

## Fuera de alcance de esta hoja de ruta

La marca/rediseño visual, el backend de Stalwart en sí, y la infraestructura de
ARGOS (que vive en su propio repo). Aquí solo el endurecimiento de Céfiro para
producción.
