# Diseño — Adaptación visual Céfiro

> El diseño de referencia es el handoff en `docs/design/cefiro/` (README con
> tokens + prototipos HTML + capturas). Alta fidelidad: colores, tipografía,
> espaciados e interacciones son FINALES. Este documento registra solo las
> decisiones de ADAPTACIÓN al codebase real.

## Alcance

**Tanda 1 — Re-skin (Planes 1–3):** identidad Céfiro completa sobre la
funcionalidad existente. Sin funciones nuevas.

**Tanda 2 — UX del prototipo (Plan 4):** atajos de teclado (j/k/e/s/r/c, `/`,
`?`, Esc), overlay de atajos, toasts de acción.

**Fuera de alcance:** funciones de IA (Resumir/Redactar) → issue #27. Sin
botones muertos ni mocks.

## Decisiones de adaptación

1. **Tokens como CSS custom properties.** Los 10 tokens por tema del README
   van en `:root[data-theme="night"]` / `:root[data-theme="light"]` (archivo
   `apps/web/src/app/theme.css`). Tailwind los expone vía `extend.colors`
   con `var(--…)` (p. ej. `bg-panel`, `text-ink`, `border-line`,
   `bg-accent`). Los componentes usan clases Tailwind semánticas, nunca
   hex directos.
2. **Tema Noche por defecto; preferencia en localStorage** (clave
   `cefiro-theme`), aplicada a `document.documentElement.dataset.theme`
   antes del primer render (snippet inline en `index.html` para evitar
   flash). Toggle en el header (icono sol/luna). Sin roundtrip al servidor.
3. **Space Grotesk auto-hosteada** (regla de egress: cero internet en
   runtime). Los `woff2` (400/500/600/700, latin + latin-ext) se descargan
   en desarrollo y se commitean en `apps/web/src/app/fonts/`; `@font-face`
   en `theme.css` con `font-display: swap`. Nada de Google Fonts.
4. **Logo animado = componente React** `CefiroLogo` (SVG inline del README:
   anillo punteado + ráfagas con dashoffset + estrella; keyframes en
   `theme.css`). Tamaños por prop (`size`): 72 login, 52 estado vacío, 32
   header.
5. **Login**: el prototipo calza 1:1 con el dual-login de F2. El flag
   `credenciales` del handoff ES el modo bootstrap existente — cuando el
   servidor no ofrece la vía de credenciales, el formulario ya está ausente
   del DOM; se le añade el aviso de "modo recuperación" del handoff. No se
   toca la lógica de auth, solo la piel.
6. **Marca**: wordmark "CÉFIRO" + tagline "correo del ecosistema" en header
   y login; `<title>` de la app pasa a "Céfiro". El repo y los paquetes NO
   se renombran (webmail sigue siendo el nombre técnico).
7. **Sello de correo** ("Enviado con CÉFIRO · el viento que mueve tu
   equipo"): bloque al pie del panel de LECTURA (border-top line, nombre
   del remitente + sello). El campo "rol" del prototipo no existe en
   nuestros datos → se omite; solo nombre + sello.
8. **Avatares**: componente `Avatar` con iniciales del nombre/email y color
   determinista de la paleta rotativa del README (hash del email → índice).
   Se usa en lista, lectura y header (usuario actual).
9. **Etiquetas**: las cuatro del prototipo (Urgente/Producto/…) son datos de
   demo. Nuestras etiquetas son keywords JMAP del usuario: el color se
   asigna determinísticamente (hash del keyword → paleta de 4 colores de
   etiqueta del README, patrón chip pill + fondo al 14%).
10. **Pantallas sin handoff** (settings, admin, setup/recuperación): se
    re-visten con el MISMO vocabulario de tokens (panel/soft/line/accent,
    radios y tipografía del README), manteniendo su estructura actual. Sin
    inventar layouts nuevos.
11. **Responsive**: se respetan las reglas del README (lista `flex:0 1
    390px` min 280px, `overflow-x:hidden`, sin scroll horizontal).
12. **Accesibilidad**: los cambios son de piel — se conservan todos los
    roles/labels/aria existentes; el contraste de los tokens ya cumple en
    ambos temas (texto ink sobre panel/bg).

## Descomposición en planes

1. **Plan 1 — Fundación**: theme.css (tokens 2 temas + keyframes +
   @font-face), fuentes woff2, Tailwind config, mecanismo de tema +
   toggle, `CefiroLogo`, `Avatar`, login re-skin, `<title>`/favicon.
2. **Plan 2 — Correo**: header (buscador, atajos-btn placeholder, avatar),
   nav (Redactar, carpetas, etiquetas), lista (filas, no-leído, chips,
   estrella, seleccionada), lectura (barra de acciones ghost, artículo,
   fadeUp, sello Céfiro, estado vacío), composer modal.
3. **Plan 3 — Resto de pantallas**: settings (firmas/filtros/vacaciones),
   admin, setup/recuperación, estados de error/carga, barrido de
   consistencia + verificación completa.
4. **Plan 4 — Atajos y toasts** (tanda 2): atajos globales del README,
   overlay "?", toasts (archivado/enviado/error) reemplazando avisos
   puntuales donde aplique — sin tocar los errores inline de formularios.

## Testing

- Unit: Avatar (hash estable), etiqueta→color estable, toggle de tema
  (dataset + localStorage).
- Los tests existentes de componentes NO deben romperse: el re-skin
  conserva textos i18n, roles y labels (los selectores de test son por
  accesibilidad, no por clases).
- Verificación visual por captura contra `docs/design/cefiro/capturas/`
  en la revisión final de cada plan.
