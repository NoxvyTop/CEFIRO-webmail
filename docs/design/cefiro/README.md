# Handoff: Webmail Céfiro

## Overview
**Céfiro** es el cliente de webmail del ecosistema (tercer producto junto a Noxvy y Argos). Interfaz de 3 columnas (carpetas / lista / lectura) para equipos de trabajo, en español, con atajos de teclado, funciones de IA (resumen y redacción asistida), etiquetas con filtro, y dos temas: **Noche** (por defecto, a juego con la estética del ecosistema) y **Claro**.

## Sobre los archivos de diseño
Los archivos de este paquete son **referencias de diseño creadas en HTML** — prototipos que muestran el aspecto y comportamiento previstos, NO código de producción para copiar tal cual. La tarea es **recrear este diseño en el entorno del codebase destino** (React, Vue, etc.) usando sus patrones y librerías existentes; si aún no hay entorno, elegir el framework más apropiado e implementarlo ahí.

## Fidelidad
**Alta fidelidad (hifi).** Colores, tipografía, espaciados e interacciones son finales. Recrear la UI de forma pixel-perfect.

## Design Tokens

### Tema Noche (por defecto)
- `--bg: #0A0B10` fondo general
- `--panel: #12141C` paneles (header, lista, modales)
- `--ink: #ECEEF4` texto principal
- `--muted: #8B90A2` texto secundario
- `--line: #232838` bordes/divisores
- `--accent: #6FE3C1` acento menta (marca, CTAs, no leídos, IA)
- `--accent-ink: #07130F` texto sobre acento
- `--soft: #171A24` superficies suaves (búsqueda, tarjeta IA)
- `--hover: #191D28` fondo hover
- `--sel: #15302B` fila/ítem seleccionado

### Tema Claro
- `--bg: #F1F4F4`, `--panel: #FFFFFF`, `--ink: #101318`, `--muted: #66707E`, `--line: #E2E7E9`, `--accent: #0FA383`, `--accent-ink: #FFFFFF`, `--soft: #EDF7F3`, `--hover: #F3F7F6`, `--sel: #DCF2EA`

### Etiquetas (iguales en ambos temas)
- Urgente: `#F26565` / fondo `rgba(242,101,101,0.14)`
- Producto: `#5B8DEF` / `rgba(91,141,239,0.14)`
- Diseño: `#E5A13D` / `rgba(229,161,61,0.15)`
- Finanzas: `#34C79A` / `rgba(52,199,154,0.14)`
- Estrella activa: `#E8C24A`

### Avatares
Paleta rotativa por id: `#3E8E7E #4E6E9E #6E5E9E #8E6E4E #4E8E5E #5E7E9E #9E5E6E #5E9E8E`, texto `#F4FBF8`.

### Tipografía
- Familia única: **Space Grotesk** (Google Fonts), pesos 400–700.
- Marca: 15px / 700 / letter-spacing 0.32em ("CÉFIRO"); tagline 10.5px muted.
- Título de correo: 26px / 650 / letter-spacing -0.01em / line-height 1.25.
- Cuerpo de correo: 15px / line-height 1.65.
- Lista: remitente 14px (700 no leído, 500 leído), asunto 13.5px (650/420), preview 12.5px muted.
- UI general: 13–14px; kbd 11–11.5px.

### Radios y sombras
- Botón principal: radius 11px, sombra `0 2px 14px rgba(111,227,193,0.25)`.
- Filas de nav: 9px. Inputs/búsqueda: 10px. Modales/tarjetas: 12–14px, sombra `0 24px 70px rgba(0,0,0,0.5)`.
- Chips de etiqueta: pill (999px). Toast: pill, fondo `--ink`, texto `--bg`.

## Pantallas / Vistas

### Login (archivo aparte: `Login Céfiro.dc.html`)
Pantalla centrada sobre fondo `--bg`: logo animado 72px · wordmark "CÉFIRO" (19px/700/tracking 0.32em) · subtítulo "Inicia sesión en el correo de tu equipo" · tarjeta 400px (panel, borde line, radius 16, sombra `0 18px 50px rgba(0,0,0,0.35)`, padding 28px) · sello de marca al pie.
- **SSO es la acción principal:** botón accent 46px con icono candado, "Iniciar sesión con SSO". Al pulsar: estado "Conectando…" + línea "Redirigiendo a tu proveedor de identidad…" (pulse) ~1.4s → toast.
- **Credenciales (correo + contraseña) es vía secundaria**, bajo divisor "o con credenciales": inputs 44px (fondo soft, borde line, focus borde accent), botón outline "Iniciar sesión" (hover borde accent). Validación inline: correo válido y contraseña no vacía (error 12.5px `#F26565`).
- **Flag `credenciales` (boolean):** en producción el acceso con credenciales existe SOLO para modo recuperación/bootstrap. Con el flag apagado, el formulario y el divisor desaparecen y se muestra un aviso: «El acceso con credenciales está deshabilitado. Disponible solo en modo recuperación.» (tarjeta soft, texto muted, centrado). Implementar como configuración de despliegue/entorno, no como opción de usuario.

### Layout raíz
Columna flex a pantalla completa: header 60px + cuerpo flex.
- **Header (60px, panel, borde inferior line):** logo animado 32px + wordmark "CÉFIRO"/tagline (min-width 210px) · buscador (max 560px, alto 40px, fondo soft, borde line, radius 10, icono lupa, kbd "/") · botón "? Atajos" · avatar usuario 36px circular fondo accent.
- **Columna 1 — Nav (230px fijo):** botón "Redactar" (44px, accent, icono lápiz) · carpetas: Recibidos (contador no leídos en accent), Destacados, Enviados, Archivados (filas 38px, radius 9, activa fondo `--sel` y peso 650) · sección "ETIQUETAS" (11px, 700, letter-spacing 0.12em) con 4 filas de 34px con punto de color 9px (radius 3).
- **Columna 2 — Lista (390px, `flex:0 1 390px`, min 280px, fondo panel, bordes laterales):** cabecera 52px con título de carpeta + chip de filtro activo (con ✕) + contador "N correos". Filas: avatar 38px + (punto no-leído 7px accent + remitente + hora) / asunto / (preview + chip etiqueta + estrella). Seleccionada: fondo `--sel` + borde izquierdo 3px accent. Hover: `--hover`. Scroll vertical, `overflow-x:hidden`.
- **Columna 3 — Lectura (flex 1):** barra de acciones 52px (Archivar, Destacar, Responder — botones ghost 32px, hover `--hover`; a la derecha pista de atajos en muted, truncable con ellipsis). Artículo max-width 780px, padding 30px 40px 60px, animación fadeUp 0.25s: título+chip · bloque remitente (avatar 42px, nombre, email "· para mí y el equipo", hora) con divisor · **tarjeta Resumen IA** · párrafos · **pie de página del correo** · botones Responder/Archivar.
- **Estado vacío (sin selección):** logo animado 52px, "Selecciona un correo", pista j/k.

### Pie de página de cada correo (nuevo, marca de producto)
Bloque tras el cuerpo, separado por `border-top: 1px line`, padding-top 18px:
- Nombre del remitente (13.5px, 600) + rol (12.5px, muted).
- Sello a 16px: mini-logo de viento 14px + "Enviado con **CÉFIRO** · el viento que mueve tu equipo" (11.5px muted; CÉFIRO en accent, 700, letter-spacing 0.14em).

### Modal Redactar
Anclado abajo-derecha (overlay `rgba(3,5,9,0.55)`), tarjeta 640px radius 14: cabecera 48px fondo soft "Nuevo mensaje" + ✕ · inputs Para / Asunto (borde inferior line) · textarea 220px · pie con "Enviar" (accent, icono avión), "✦ Redactar con IA" (outline accent) y "Descartar".

### Overlay Atajos
Tarjeta centrada 400px, grid 2 columnas: j/k moverse, e archivar, s destacar, r responder, c redactar, / buscar, Esc cerrar. Se cierra al hacer clic fuera.

### Toast
Pill centrado abajo (bottom 26px), animación fadeUp 0.22s, autocierre 2.6s.

## Logo animado (SVG 40×40, stroke accent)
1. Anillo punteado: círculo r=18, stroke 1.3, `stroke-dasharray: 3.5 6.5`, opacity 0.45, rotación continua 28s lineal (`transform-origin:center`).
2. Tres ráfagas de viento con rizo (paths `M9 15h13a3.6 3.6 0 1 0-3.6-6.3`, `M7 21h19a3.6 3.6 0 1 1 3.6 6.3`, `M9 27h10`), stroke 2.3 round, `stroke-dasharray: 12 36` y animación `stroke-dashoffset → -96` en 3.4s lineal infinito, con delays -1.1s y -2.2s (efecto de viento fluyendo).
3. Estrella: círculo r=1.6 en (33,8) con parpadeo (opacity 0.25→1 + scale 0.7→1.2, 2.4s).

Keyframes: `logoSpin { to { transform: rotate(360deg) } }`, `windFlow { to { stroke-dashoffset: -96 } }`, `twinkle`.

## Interacciones y comportamiento
- **Abrir correo:** clic o Enter → marca como leído, panel de lectura con fadeUp.
- **Atajos globales** (ignorados mientras se escribe en un input/textarea): `j`/`k` siguiente/anterior (abre al navegar), `e` archivar, `s` destacar, `r` responder, `c` redactar, `/` foco al buscador, `?` overlay de atajos, `Esc` cierra modal/overlay o quita foco.
- **Archivar:** mueve a Archivados, selecciona el siguiente (o anterior) y muestra toast "Correo archivado · pulsa e para archivar más rápido".
- **Destacar:** toggle ★ (clic en fila detiene propagación).
- **Filtros:** carpeta activa + etiqueta opcional (toggle; chip con ✕ en cabecera de lista) + búsqueda por remitente/asunto/preview (case-insensitive).
- **Resumen IA:** botón "✦ Resumir con IA" → estado "Analizando el mensaje…" (pulse 1.2s) ~1.1s → lista de 3 viñetas (persistente por correo).
- **Redactar con IA:** requiere asunto (si no, toast de aviso); ~0.95s "Redactando…" → rellena el cuerpo con borrador en español y toast "✦ Borrador generado por IA — revísalo antes de enviar".
- **Enviar:** requiere destinatario (si no, toast); añade a Enviados, cierra modal, toast "Correo enviado".
- **Hovers:** filas/botones ghost → `--hover`; CTAs accent → brightness(1.07) y scale(0.98) al pulsar; estrella scale(1.2).
- **Responsive:** la lista puede encoger hasta 280px; los contenedores de scroll llevan `overflow-x:hidden`; la pista de atajos se trunca con ellipsis. Sin scroll horizontal en ningún ancho.

## Gestión de estado
- `emails[]`: id, from, email, role, folder (inbox/sent/archive), unread, starred, label, time, ts, subject, preview, paras[], ai[] (viñetas del resumen).
- `folder`, `label`, `query`, `selectedId`.
- `composeOpen`, `composeTo/Subject/Body`, `aiWriting`.
- `aiDone{}` (map id→bool), `aiLoadingId`, `showShortcuts`, `toast`.
- "Destacados" es una vista filtrada (starred y no archivado), no una carpeta.
- El tema es una preferencia global (Noche/Claro) que conmuta los tokens.

## Assets
- Fuente: Space Grotesk vía Google Fonts.
- Iconos: SVG inline stroke `currentColor` (bandeja, estrella, avión, caja de archivo, lápiz, lupa, flecha responder) — 15–17px, stroke-width 2.
- Logo: SVG inline descrito arriba (no hay archivos de imagen).

## Archivos
- `Webmail Céfiro.dc.html` — prototipo completo (markup + lógica de referencia). El bloque de estilos/keyframes está en la cabecera del archivo; todos los estilos de componentes son inline.
- `capturas/` — capturas de referencia:
  - `01` bandeja de entrada (tema Noche, correo abierto)
  - `02` resumen IA generado
  - `03` modal Redactar
  - `04` overlay de atajos de teclado
  - `05` tema Claro
  - `01-login` pantalla de login completa (SSO + credenciales, tema Noche)
  - `02-login` login con credenciales deshabilitadas (solo SSO + aviso de modo recuperación)
