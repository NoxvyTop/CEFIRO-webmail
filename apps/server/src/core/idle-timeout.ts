// Bun.serve applies ONE global idleTimeout to every connection (default 10s) as
// slowloris protection. A long-lived SSE stream (GET /mail/events) legitimately
// sits idle between upstream keepalive pings (30s), so under the global default
// Bun force-closes it every 10s and the client reconnect-storms (GH #204). Bun's
// only per-connection control is `server.timeout(request, seconds)`, which needs
// the server handle — held here so the SSE route can clear its own deadline
// without weakening the global default that protects every other route. We model
// just the one method we call (structurally satisfied by the real Bun server)
// to avoid depending on Bun's generic `Server<WebSocketData>` type parameter.
type TimeoutCapable = { timeout(request: Request, seconds: number): void };

let server: TimeoutCapable | undefined;

/** Wire the running server so long-lived routes can clear their idle deadline. */
export function registerServer(s: TimeoutCapable): void {
  server = s;
}

/** Test seam: forget any registered server. */
export function resetServerForTests(): void {
  server = undefined;
}

/**
 * Disable the idle timeout for this one connection. No-op when no server is
 * registered (e.g. under vitest, where handlers run without `Bun.serve`).
 */
export function clearIdleTimeout(request: Request): void {
  server?.timeout(request, 0);
}
