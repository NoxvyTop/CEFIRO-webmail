import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { routes } from "../../app/routes";

const user = {
  userId: "u1",
  email: "emp@noxvytop.com",
  displayName: "Emp",
  role: "employee",
  locale: "es",
};

const mailboxes = [
  {
    id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox",
    sortOrder: 0, unreadEmails: 3, totalEmails: 10,
  },
];

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  private listeners: Record<string, ((event: unknown) => void)[]> = {};
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners[type] ??= [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }

  close() {
    this.closed = true;
  }

  emitMessage(data = "{}") {
    for (const listener of this.listeners["message"] ?? []) {
      listener({ data });
    }
  }

  emitError() {
    for (const listener of this.listeners["error"] ?? []) {
      listener({});
    }
  }
}

function renderAt(path: string, client: QueryClient) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/auth/me")) return new Response(JSON.stringify(user));
      if (path.includes("/api/mail/mailboxes")) return new Response(JSON.stringify(mailboxes));
      if (path.includes("/api/mail/messages")) {
        return new Response(JSON.stringify({ total: 0, position: 0, emails: [] }));
      }
      return new Response(JSON.stringify({ status: "ok", checks: {} }));
    }),
  );
}

describe("mail SSE live refresh and notifications", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens an EventSource to /api/mail/events and refetches only what the event says changed", async () => {
    stubFetch();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderAt("/", client);

    await screen.findAllByText(i18n.t("mail.folders.inbox"));

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe("/api/mail/events");

    FakeEventSource.instances[0]?.emitMessage(
      JSON.stringify({ "@type": "StateChange", changed: { acc: { Email: "s1" } } }),
    );

    const keys = invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey: string[] }).queryKey);
    // #340: the mailbox key rides along with Email — arriving mail moves unread
    // counts, including the per-shared-account ones the sidebar's group rows read.
    expect(keys).toEqual([
      ["mail", "messages"],
      ["mail", "thread"],
      ["mail", "mailboxes"],
    ]);
    // GH #167: the whole-namespace sweep also refetched mailboxes, identities,
    // preferences and every loaded page of the infinite listing, on every event.
    expect(keys).not.toContainEqual(["mail"]);
  });

  it("fires a Notification when the tab is hidden and permission is granted", async () => {
    stubFetch();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const notificationCtor = vi.fn();
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      constructor(title: string) {
        notificationCtor(title);
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    Object.defineProperty(document, "hidden", { value: true, configurable: true });

    renderAt("/", client);
    await screen.findAllByText(i18n.t("mail.folders.inbox"));

    FakeEventSource.instances[0]?.emitMessage();

    expect(notificationCtor).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });
});
