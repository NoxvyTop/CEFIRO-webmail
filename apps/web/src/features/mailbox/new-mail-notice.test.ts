import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mailbox } from "@webmail/shared";
import {
  createNewMailNotice,
  inboxUnreadCount,
  NEW_MAIL_NOTICE_DEBOUNCE_MS,
  NEW_MAIL_NOTICE_TAG,
  PERSONAL_MAILBOXES_QUERY_KEY,
} from "./newMailNotice";

// GH #338: `new Notification(...)` fired for ANY frame carrying `Email` — a
// flag flipped from another tab, a message moved, a send, a change in a shared
// account. What actually means "you have new mail" is the personal Inbox's
// unread count going up.

const { getExistingPushSubscription } = vi.hoisted(() => ({
  getExistingPushSubscription: vi.fn(),
}));
vi.mock("../notifications/push", () => ({ getExistingPushSubscription }));

function mailbox(overrides: Partial<Mailbox>): Mailbox {
  return {
    id: "mb-inbox",
    name: "Inbox",
    role: "inbox",
    parentId: null,
    totalEmails: 10,
    unreadEmails: 0,
    ...overrides,
  } as Mailbox;
}

function clientWith(mailboxes: Mailbox[] | undefined): QueryClient {
  const client = new QueryClient();
  if (mailboxes) client.setQueryData(PERSONAL_MAILBOXES_QUERY_KEY, mailboxes);
  return client;
}

let constructed: { title: string; options?: NotificationOptions }[];

function stubNotification(permission: NotificationPermission) {
  constructed = [];
  class FakeNotification {
    constructor(title: string, options?: NotificationOptions) {
      constructed.push({ title, options });
    }
    static permission = permission;
  }
  vi.stubGlobal("Notification", FakeNotification);
}

function notice(now: () => number = () => 0) {
  return createNewMailNotice({
    translate: (count) => ({ title: "Correo nuevo", body: `${count} sin leer` }),
    now,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getExistingPushSubscription.mockResolvedValue(null);
  stubNotification("granted");
  Object.defineProperty(document, "hidden", { value: true, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inboxUnreadCount", () => {
  it("reads the personal Inbox's unread count", () => {
    const client = clientWith([mailbox({ unreadEmails: 4 }), mailbox({ id: "mb-sent", role: "sent" })]);
    expect(inboxUnreadCount(client)).toBe(4);
  });

  it("is null when the mailboxes have not been loaded", () => {
    expect(inboxUnreadCount(clientWith(undefined))).toBeNull();
  });

  it("is null when the account has no Inbox role", () => {
    expect(inboxUnreadCount(clientWith([mailbox({ role: "archive" })]))).toBeNull();
  });
});

describe("createNewMailNotice", () => {
  it("notifies when the Inbox unread count grew", async () => {
    await notice()(2, 3);

    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.title).toBe("Correo nuevo");
    expect(constructed[0]?.options).toMatchObject({ body: "1 sin leer", tag: NEW_MAIL_NOTICE_TAG });
  });

  it("stays silent for a flag change that leaves the count where it was", async () => {
    await notice()(3, 3);
    expect(constructed).toHaveLength(0);
  });

  it("stays silent when a message was read elsewhere and the count fell", async () => {
    await notice()(3, 1);
    expect(constructed).toHaveLength(0);
  });

  it("stays silent when either side of the comparison is unknown", async () => {
    const fire = notice();
    await fire(null, 3);
    await fire(2, null);
    expect(constructed).toHaveLength(0);
  });

  it("stays silent while the tab is in the foreground", async () => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    await notice()(1, 2);
    expect(constructed).toHaveLength(0);
  });

  it("stays silent without the browser permission", async () => {
    stubNotification("default");
    await notice()(1, 2);
    expect(constructed).toHaveLength(0);
  });

  // Web Push already delivers this exact message through the service worker.
  it("stays silent when this device has a push subscription", async () => {
    getExistingPushSubscription.mockResolvedValue({ endpoint: "https://push.test/a" });
    await notice()(1, 2);
    expect(constructed).toHaveLength(0);
  });

  it("still notifies when the push lookup fails", async () => {
    getExistingPushSubscription.mockRejectedValue(new Error("no service worker"));
    await notice()(1, 2);
    expect(constructed).toHaveLength(1);
  });

  it("collapses a burst of arrivals into one notification", async () => {
    let clock = 0;
    const fire = notice(() => clock);

    await fire(1, 2);
    clock += NEW_MAIL_NOTICE_DEBOUNCE_MS - 1;
    await fire(2, 5);

    expect(constructed).toHaveLength(1);
  });

  it("notifies again once the debounce window has passed", async () => {
    let clock = 0;
    const fire = notice(() => clock);

    await fire(1, 2);
    clock += NEW_MAIL_NOTICE_DEBOUNCE_MS;
    await fire(2, 3);

    expect(constructed).toHaveLength(2);
  });
});
