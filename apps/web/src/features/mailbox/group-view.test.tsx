import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { routes } from "../../app/routes";

const user = {
  userId: "u1",
  email: "primary@x.com",
  displayName: "Primary",
  role: "employee",
  locale: "es",
};

const mailboxes = [
  {
    id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox",
    sortOrder: 0, unreadEmails: 0, totalEmails: 0,
  },
];

const identities = [
  { id: "i1", name: "Primary", email: "primary@x.com" },
  { id: "i2", name: "Soporte", email: "soporte@x.com" },
];

function stubFetch(preferences: { groupMailInMainInbox: boolean }) {
  const prefsState = { ...preferences };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/auth/me")) return new Response(JSON.stringify(user));
    if (url.includes("/api/mail/mailboxes")) return new Response(JSON.stringify(mailboxes));
    if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(identities));
    if (url.includes("/api/mail/preferences") && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { groupMailInMainInbox?: boolean };
      if (typeof body.groupMailInMainInbox === "boolean") {
        prefsState.groupMailInMainInbox = body.groupMailInMainInbox;
      }
      return new Response(JSON.stringify(prefsState));
    }
    if (url.includes("/api/mail/preferences")) return new Response(JSON.stringify(prefsState));
    if (url.includes("/api/mail/messages")) {
      return new Response(JSON.stringify({ total: 0, position: 0, emails: [] }));
    }
    return new Response(JSON.stringify({ status: "ok", checks: {} }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderAt(path: string, preferences: { groupMailInMainInbox: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const fetchMock = stubFetch(preferences);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { fetchMock };
}

function messagesCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes("/api/mail/messages"));
}

describe("group view filtering", () => {
  it("requests messages with to=<group address> and the inbox mailbox id in group view", async () => {
    const { fetchMock } = renderAt("/?group=soporte@x.com", { groupMailInMainInbox: false });

    await screen.findByText("Inbox");
    const calls = await vi.waitFor(() => {
      const found = messagesCalls(fetchMock);
      expect(found.some((url) => url.includes("to=soporte%40x.com"))).toBe(true);
      return found;
    });

    expect(calls.some((url) => url.includes("mailboxId=mb-inbox"))).toBe(true);
    expect(screen.getByRole("separator", { name: i18n.t("mail.resizeList") })).toBeInTheDocument();
  });

  it("excludes group addresses from the main inbox when the toggle is off", async () => {
    const { fetchMock } = renderAt("/", { groupMailInMainInbox: false });

    await screen.findAllByText("Inbox");
    await vi.waitFor(() => {
      const found = messagesCalls(fetchMock);
      expect(found.some((url) => url.includes("excludeTo=soporte%40x.com"))).toBe(true);
    });
  });

  it("turning the toggle on updates preferences and refetches inbox without excludeTo", async () => {
    const { fetchMock } = renderAt("/", { groupMailInMainInbox: false });

    const toggle = await screen.findByRole("checkbox", { name: i18n.t("groups.showInInbox") });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await vi.waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes("/api/mail/preferences") && (init as RequestInit | undefined)?.method === "PUT",
      );
      expect(putCall).toBeTruthy();
      const [, init] = putCall as [RequestInfo | URL, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ groupMailInMainInbox: true });
    });

    await vi.waitFor(() => {
      const found = messagesCalls(fetchMock);
      const last = found[found.length - 1];
      expect(last).toBeDefined();
      expect(last).not.toContain("excludeTo");
    });
  });
});
