# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/)
y el versionado sigue [SemVer](https://semver.org/lang/es/).

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

[0.1.0]: https://github.com/NoxvyTop/CEFIRO-webmail/releases/tag/v0.1.0
