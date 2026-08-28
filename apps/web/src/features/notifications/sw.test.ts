import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// GH #337 (c): the service worker is plain JS shipped from public/, outside the
// bundle and outside every import graph — so nothing ever exercised it. It is
// loaded here in a fake worker scope and driven through its two events, which
// is the only way its URL building can be asserted at all.

// process.cwd() is the package root under vitest; import.meta.url is an http
// URL in the jsdom environment and cannot be turned into a path.
const SW_SOURCE = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");

type Listener = (event: unknown) => void;

function loadServiceWorker() {
  const listeners = new Map<string, Listener>();
  type NotificationOptions = { body?: string; tag?: string; icon?: string; badge?: string; data?: unknown };
  const showNotification = vi.fn(
    async (_title: string, _options: NotificationOptions) => undefined,
  );
  const openWindow = vi.fn(async (_url: string) => undefined);
  const navigate = vi.fn(async () => undefined);
  const focus = vi.fn(async () => undefined);
  let windows: unknown[] = [];

  const self = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    registration: { showNotification },
    clients: {
      matchAll: async () => windows,
      openWindow,
    },
  };
  new Function("self", SW_SOURCE)(self);

  return {
    showNotification,
    openWindow,
    navigate,
    focus,
    setOpenWindows(next: unknown[]) {
      windows = next;
    },
    async push(payload: unknown) {
      const waits: unknown[] = [];
      listeners.get("push")?.({
        data: payload === undefined ? null : { json: () => payload },
        waitUntil: (promise: unknown) => waits.push(promise),
      });
      await Promise.all(waits);
      return showNotification.mock.calls.at(-1);
    },
    async click(data: unknown) {
      const waits: Promise<unknown>[] = [];
      listeners.get("notificationclick")?.({
        notification: { close: vi.fn(), data },
        waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      });
      await Promise.all(waits);
    },
  };
}

let sw: ReturnType<typeof loadServiceWorker>;

beforeEach(() => {
  sw = loadServiceWorker();
});

describe("service worker push handler", () => {
  it("shows the notification the payload carries", async () => {
    const call = await sw.push({ title: "Alice", body: "Factura", targetId: "t1" });

    expect(call?.[0]).toBe("Alice");
    expect(call?.[1]).toMatchObject({ body: "Factura", tag: "t1" });
    expect(call?.[1]?.data).toEqual({ targetId: "t1", accountId: undefined });
  });

  it("carries the account id through to the click handler", async () => {
    const call = await sw.push({ title: "Buzón", body: "Aviso", targetId: "t9", accountId: "acc-9" });

    expect(call?.[1]?.data).toEqual({ targetId: "t9", accountId: "acc-9" });
  });

  // GH #350: /favicon.svg was used for both. Android Chrome ignores SVG in
  // notifications (no icon at all), and `badge` must be a monochrome PNG mask.
  it("uses PNG art for the icon and the badge", async () => {
    const call = await sw.push({ title: "Alice", body: "Factura" });

    expect(call?.[1]?.icon).toMatch(/\.png$/);
    expect(call?.[1]?.badge).toMatch(/\.png$/);
  });

  it("falls back to a generic notification for an unreadable payload", async () => {
    const call = await sw.push(undefined);

    expect(call?.[0]).toBe("Céfiro");
    expect(call?.[1]?.body).toBe("");
  });
});

describe("service worker notificationclick handler", () => {
  it("opens the thread in the personal account", async () => {
    await sw.click({ targetId: "t1" });

    expect(sw.openWindow).toHaveBeenCalledWith("/?thread=t1");
  });

  // GH #337 (c): without the account, a push about a shared mailbox opened the
  // personal view and the thread id simply did not resolve there.
  it("opens a shared-account thread with its account, so the id resolves", async () => {
    await sw.click({ targetId: "t9", accountId: "acc 9" });

    expect(sw.openWindow).toHaveBeenCalledWith("/?account=acc%209&thread=t9");
  });

  it("falls back to the inbox when the push carried no target", async () => {
    await sw.click({});

    expect(sw.openWindow).toHaveBeenCalledWith("/");
  });

  it("steers an already-open tab instead of opening a second one", async () => {
    const client = { focus: vi.fn(), navigate: vi.fn(async () => undefined) };
    sw.setOpenWindows([client]);

    await sw.click({ targetId: "t1" });

    expect(client.navigate).toHaveBeenCalledWith("/?thread=t1");
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(sw.openWindow).not.toHaveBeenCalled();
  });
});
