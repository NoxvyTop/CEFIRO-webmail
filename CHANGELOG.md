# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/)
y el versionado sigue [SemVer](https://semver.org/lang/es/).

## [0.2.0] - 2026-08-27

Segunda versión estable: todo lo promovido de `preproduc` a `main` desde la
0.1.0 (veinte PRs, de #51 a #325). Cambia el contrato de configuración del
proveedor de correo (`JMAP_URL`), por eso sube la versión menor.

### Añadido

- Buzones compartidos (#312, #320): el miembro ve y entra a los buzones de
  grupo que Stalwart expone en su sesión con su propia credencial; selector de
  cuenta en la cabecera; copia manual de un mensaje a la bandeja personal; y
  **entrega automática opt-in** de copias — un vigilante JMAP (EventSource) por
  buzón más un sondeo periódico de seguridad, ciclo de entrega serializado por
  arrendamiento en base de datos, cursor persistente y libro de copias con
  estado (`pending/copied/failed`), verificación por `Message-ID` antes de
  reintentar y rastro para los miembros que no se pueden servir.
- Indicador de remitente conocido / servicio de confianza (#320): `senderTrust`
  sobre el veredicto DMARC — `known` (has escrito antes a esa dirección) o
  `trusted-service` (dominio en la lista curada o confirmada por el usuario);
  atado al dominio evaluado por DMARC y a un único `From`; acción «Confiar en
  este servicio» en el lector; tabla `sent_recipients`.
- Asistente de IA (#51, #306, #309): resumen del hilo y redacción por
  intención (humanizada), proveedores Anthropic y Mistral, caché de resúmenes;
  desactivado por defecto (`AI_ENABLED`).
- Consola de administración rediseñada con gráficos (#97).
- Portabilidad JMAP (#52): `JMAP_URL`, `JMAP_URL_MODE` (`rewrite|trust`),
  `JMAP_AUTH_MODE` (`basic|bearer`), `JMAP_TIMEOUT_MS`, `JMAP_AUTHSERV_ID`;
  sonda de arranque que registra la URL anunciada frente a la resuelta;
  detección de la capacidad Sieve; matriz de topologías en `docs/OPERATIONS.md`.
- Insignia de autenticación DMARC en el lector, condicionada al
  `authserv-id` configurado (#286).
- Scaffolding de notificaciones push web (VAPID) (#306).
- Mejoras de UX en móvil web: atajos, login, `safe-area`, redactor (#297).
- Métricas: `cefiro_shared_mailbox_copies_total{result}` y las series de
  las auditorías; verificación de restauración (`restore-drill`) en CI.

### Cambiado

- **Contrato de configuración**: `STALWART_URL` pasa a `JMAP_URL` (el nombre
  antiguo sigue funcionando con aviso); `JMAP_FORCE_BASE` se retira y se
  anuncia en el arranque; `STALWART_TIMEOUT_MS` → `JMAP_TIMEOUT_MS`.
- El flujo de eventos `/api/mail/events` responde `X-Accel-Buffering: no`
  para no quedar retenido tras un proxy con `proxy_buffering on` (#316).
- Apagado ordenado: los trabajos de fondo se detienen antes de drenar el
  servidor y ambos comparten un único plazo (`≤ SHUTDOWN_GRACE_MS + 1 s`).
- La sesión JMAP se puede obtener fuera de una petición (`getMailSession`)
  para el trabajo de fondo, sobre la misma caché.
- Imagen: bases pineadas por digest, etiqueta `sha-<commit>` inmutable, SBOM
  y procedencia adjuntas, compuerta de vulnerabilidades (Trivy) y prueba de
  humo antes de publicar (#190, #260); el fixture e2e de Stalwart se
  direcciona por contenido.
- CI: el job que gate `main` corre en infraestructura de GitHub; las subidas
  de artefactos no tumban una suite verde; retención automática de versiones
  de imagen sin etiqueta en GHCR.

### Seguridad

- Endurecimiento para producción (#203, #233, #264, #284, #311): límites de
  tasa por IP con `TRUSTED_PROXY_HOPS`, sesión endurecida, auditoría por
  página, clamps hacia JMAP, `pdfjs-dist` 6.2.108 (CVE-2026-16633).
- La confianza en el remitente nunca se concede solo por DMARC `pass`, ni
  a un dominio parecido, ni con más de un `From`.
- La semilla de servicios de confianza excluye dominios que reenvían
  contenido de terceros.

### Corregido

- Paridad visual y de interacción con el diseño de referencia y auditorías
  v2–v6 (#54, #67, #81, #117, #139, #175): temas, hilos, firmas, redactor,
  correo real.
- Hallazgos de los Juicios Finales de #317, #318 y #319 (lease en lugar de
  bloqueo transaccional, baseline por miembro con `receivedAt`, rotación y
  tope del rastro de copias, verificación aislada de la degradación del
  cliente JMAP).

### Notas de despliegue

- Migraciones nuevas: `0014_sent_recipients.sql`, `0015_shared_mailbox_copies.sql`.
- Variables nuevas: `SHARED_MAILBOX_COPY_ENABLED` (`true|1|false|0`, activa
  por defecto e inerte sin opt-ins), `SHARED_MAILBOX_COPY_POLL_MS` (300000).
- Del lado del despliegue: `JMAP_URL=https://mx.<dominio>`; en Stalwart,
  permitir `/jmap` en el listener público si Céfiro corre en otro host.

## [0.1.0] - 2026-07-13

Primera versión estable de Céfiro: base funcional del webmail corporativo
promovida de `preproduc` a `main` tras revisión adversarial completa.

### Añadido

- Webmail de 3 columnas (carpetas / lista / lectura) sobre JMAP (Stalwart):
  lectura, redacción con firmas y adjuntos, responder/responder a todos/
  reenviar, archivar, destacar, búsqueda y atajos de teclado.
- Autenticación OIDC (Authentik) con aprovisionamiento JIT, más modo
  bootstrap/recuperación con credencial temporal de emergencia.
- Portal de administración: usuarios (roles, activación, credencial de
  buzón), grupos de correo y configuración SSO.
- Filtros Sieve: reglas de filtrado y respuesta de vacaciones.
- Temas Noche y Claro con persistencia; interfaz en español e inglés.
- Suite e2e (Playwright) con fixture Stalwart preaprovisionada; CI con
  test + e2e + publicación de imagen en GHCR.

### Seguridad

- Cabeceras de seguridad globales: CSP estricta (`script-src 'self'`),
  `frame-ancestors 'none'`, HSTS, `nosniff` y `Referrer-Policy`, con
  override por ruta (CSP `sandbox` del proxy de adjuntos).
- OIDC exige `email_verified` antes de aceptar el claim de email.
- Guardas contra lockout de administración (auto-degradación / último
  admin) con respuestas 409 específicas.
- Purga de sesiones expiradas y clamps de paginación hacia JMAP.
- Invalidación de la caché de sesión JMAP en logout, rotación de
  credencial y archivado de usuario.
- Imagen Docker de producción con dependencias de producción únicamente
  y sin archivos de test.

### Corregido

- Inicialización del tema movida del script inline al bundle
  (`themeInit.ts`) para cumplir la CSP sin desincronizar `data-theme`
  del estado de React (garantía pre-mount; trade-off documentado en #41).

[0.2.0]: https://github.com/NoxvyTop/CEFIRO-webmail/releases/tag/v0.2.0
[0.1.0]: https://github.com/NoxvyTop/CEFIRO-webmail/releases/tag/v0.1.0
