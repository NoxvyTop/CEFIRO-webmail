import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { routes } from "../../app/routes";

// GH #145: <Composer> is keyed on the compose param, so switching compose
// targets remounts it. Without the key, useComposer — which reads `initial`
// only at mount (useReducer's lazy init, plus the refs seeded from it) — would
// keep serving the PREVIOUS message's draft under the new URL.
//
// The visible symptoms (a stale To or subject) are the mild half. The
// dangerous half is invisible: inReplyTo/references are not rendered anywhere,
// so a stale pair would silently graft the reply onto an unrelated thread and
// disclose that thread's Message-IDs to a recipient who was never part of it.
// That is why this is tested at the routing level rather than trusted to the
// UI paths that happen not to reach it today.

function email(id: string, subject: string, from: string, messageId: string) {
  return {
    id,
    threadId: "t1",
    mailboxIds: ["mb-inbox"],
    from: [{ name: null, email: from }],
    to: [{ name: null, email: "u1@noxvytop.com" }],
    cc: [],
    replyTo: [],
    subject,
    receivedAt: "2026-07-01T10:00:00.000Z",
    preview: subject,
    keywords: {},
    hasAttachment: false,
    size: 10,
    bodyHtml: `<p>${subject} body</p>`,
    bodyText: null,
    attachments: [],
    messageId: [messageId],
    references: null,
    inReplyTo: null,
    senderAuth: "unknown",
    senderTrust: "none",
    bodyTruncated: false,
  };
}

function stubFetch() {
  const thread = {
    id: "t1",
    emails: [
      email("e1", "Alpha", "alpha@example.com", "alpha@example.com"),
      email("e2", "Beta", "beta@example.com", "beta@example.com"),
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) {
        return new Response(
          JSON.stringify({
            userId: "u1", email: "u1@noxvytop.com", displayName: "U1", role: "employee", locale: "es",
          }),
        );
      }
      if (url.includes("/api/mail/mailboxes")) {
        return new Response(
          JSON.stringify([
            { id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox", sortOrder: 0, unreadEmails: 0, totalEmails: 0 },
          ]),
        );
      }
      if (url.includes("/api/mail/identities")) {
        return new Response(JSON.stringify([{ id: "id1", name: "U1", email: "u1@noxvytop.com" }]));
      }
      if (url.includes("/api/mail/signatures")) return new Response(JSON.stringify([]));
      if (url.includes("/api/mail/preferences")) {
        return new Response(JSON.stringify({ groupMailInMainInbox: false }));
      }
      if (url.includes("/api/mail/threads/t1")) return new Response(JSON.stringify(thread));
      if (url.includes("/api/mail/messages")) {
        return new Response(JSON.stringify({ total: 0, position: 0, emails: [] }));
      }
      return new Response(JSON.stringify({ status: "ok", checks: {} }));
    }),
  );
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function subjectField(): HTMLInputElement {
  return screen.getByRole("textbox", { name: i18n.t("composer.subject") }) as HTMLInputElement;
}

describe("composer keying across compose targets (GH #145)", () => {
  it("rebuilds the draft when the compose target changes while the composer stays open", async () => {
    stubFetch();
    const router = renderAt("/?thread=t1&compose=reply:e1");

    await waitFor(() => expect(subjectField().value).toBe("Re: Alpha"));

    // Straight from one compose URL to another, with no intermediate entry
    // that would unmount the composer on its own.
    await router.navigate("/?thread=t1&compose=reply:e2");

    await waitFor(() => expect(subjectField().value).toBe("Re: Beta"));
  });

  it("re-addresses the reply to the new target's sender, not the previous one", async () => {
    stubFetch();
    const router = renderAt("/?thread=t1&compose=reply:e1");

    const removeAlpha = i18n.t("composer.removeRecipient", { email: "alpha@example.com" });
    const removeBeta = i18n.t("composer.removeRecipient", { email: "beta@example.com" });
    expect(await screen.findByRole("button", { name: removeAlpha })).toBeInTheDocument();

    await router.navigate("/?thread=t1&compose=reply:e2");

    expect(await screen.findByRole("button", { name: removeBeta })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: removeAlpha })).not.toBeInTheDocument();
  });

  // The assertion that actually covers the harm in #145: the threading headers
  // are never rendered, so only the outgoing payload can show whether they
  // followed the compose target. A stale In-Reply-To here would attach this
  // reply to Alpha's conversation and hand Alpha's Message-ID to Beta.
  it("sends the new target's threading headers, never the previous target's", async () => {
    stubFetch();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const router = renderAt("/?thread=t1&compose=reply:e1");

    await waitFor(() => expect(subjectField().value).toBe("Re: Alpha"));
    await router.navigate("/?thread=t1&compose=reply:e2");
    await waitFor(() => expect(subjectField().value).toBe("Re: Beta"));

    fireEvent.click(screen.getByRole("button", { name: i18n.t("composer.send") }));

    await waitFor(() => {
      const sendCall = fetchMock.mock.calls.find(
        (call: unknown[]) => String(call[0]).includes("/api/mail/send"),
      );
      expect(sendCall).toBeDefined();
      const payload = JSON.parse(String((sendCall?.[1] as RequestInit).body));
      expect(payload.inReplyTo).toEqual(["beta@example.com"]);
      expect(payload.references).toEqual(["beta@example.com"]);
      expect(payload.subject).toBe("Re: Beta");
    });
  });
});
