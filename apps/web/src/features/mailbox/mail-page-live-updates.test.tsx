import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { ToastProvider } from "../../app/ui/toast";
import { MailPage } from "./MailPage";

// GH #274: a second tab over the 8/user stream cap gets 429 too_many_streams.
// useMailEvents distinguishes that from a session failure (see
// use-mail-events-hook.test.tsx); this is the view side — MailPage must turn
// that flag into a visible, persistent notice instead of a tab that silently
// never goes live.

// Minimal EventSource stand-in: records instances and lets a test refuse the
// handshake (readyState CLOSED + an error event), mirroring the double in
// use-mail-events-hook.test.tsx.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0;
  private listeners: Record<string, ((event: unknown) => void)[]> = {};

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
    this.readyState = 2;
  }

  refuseHandshake() {
    this.readyState = 2;
    for (const listener of this.listeners.error ?? []) listener({});
  }
}

function stubFetch(eventsStatus: number) {
  const user = { userId: "u1", email: "u1@noxvytop.com", displayName: "U1", role: "employee", locale: "es" };
  const mailboxes = [
    { id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox", sortOrder: 0, unreadEmails: 0, totalEmails: 0 },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // The refused-handshake probe: the endpoint the client re-asks with fetch()
    // to recover the status EventSource hid.
    if (url.includes("/api/mail/events")) return new Response(null, { status: eventsStatus });
    if (url.includes("/api/auth/me")) return new Response(JSON.stringify(user));
    if (url.includes("/api/mail/mailboxes")) return new Response(JSON.stringify(mailboxes));
    if (url.includes("/api/mail/identities")) {
      return new Response(JSON.stringify([{ id: "id1", name: "U1", email: "u1@noxvytop.com" }]));
    }
    if (url.includes("/api/mail/preferences")) return new Response(JSON.stringify({ groupMailInMainInbox: false }));
    if (url.includes("/api/mail/messages")) {
      return new Response(JSON.stringify({ total: 0, position: 0, emails: [] }));
    }
    return new Response(JSON.stringify({ status: "ok", checks: {} }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderMailPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/"]}>
          <MailPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MailPage live-updates limited banner (GH #274)", () => {
  it("shows a persistent notice when this tab's stream is refused with 429 too_many_streams", async () => {
    stubFetch(429);
    renderMailPage();

    // The hook opens exactly one stream; refuse its handshake for the cap.
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => {
      FakeEventSource.instances[0]?.refuseHandshake();
    });

    const banner = await screen.findByText(i18n.t("mail.liveUpdatesLimited"));
    expect(banner).toBeInTheDocument();
    // Polite, not an alert — it is an ongoing condition, not an error event.
    expect(banner).toHaveAttribute("role", "status");
  });

  it("does not show the notice while the stream is healthy", async () => {
    stubFetch(200);
    renderMailPage();

    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    // No refusal — the banner must never appear on the happy path.
    expect(screen.queryByText(i18n.t("mail.liveUpdatesLimited"))).not.toBeInTheDocument();
  });
});
