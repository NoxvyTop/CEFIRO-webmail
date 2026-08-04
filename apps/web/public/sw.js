// Céfiro Web Push service worker (#294, delivery slice).
//
// Intentionally minimal: it shows the notification carried by a push and opens
// the app when one is clicked. It registers NO `fetch` handler, so it never
// intercepts navigation or caches anything — it is a notification receiver, not
// an offline layer, and cannot break the SPA it ships beside.
//
// The push payload is the privacy contract from the server (core/push.ts):
// `{ title, body, targetId? }` and nothing else — never a message body.

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || "Céfiro";
  const options = {
    body: payload.body || "",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    // Carried through to the click handler so it can open the right thread.
    data: { targetId: payload.targetId },
    // Collapse repeat pushes about the same thread into one notification.
    tag: payload.targetId || undefined,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetId = event.notification.data && event.notification.data.targetId;
  // The reader opens a thread from the `thread` query param (see MailPage), so
  // deep-link straight to it; fall back to the inbox when there is no target.
  const url = targetId ? `/?thread=${encodeURIComponent(targetId)}` : "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus an existing tab and steer it to the target rather than opening a
      // duplicate one whenever the app is already open.
      for (const client of clients) {
        if ("focus" in client) {
          if ("navigate" in client) {
            client.navigate(url).catch(() => {});
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
