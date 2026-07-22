import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { routes } from "../../app/routes";

// CLARO-07/OSCURO-05: the unlinked-mailbox state must read as onboarding, not
// as an error — no role="alert", no warn coloring, a branded empty state with
// a CTA gated by the viewer's role (only admins can self-serve the link).

function jsonError(code: string, status = 503) {
  return new Response(JSON.stringify({ code, message: `errors.${code}`, traceId: "t1" }), { status });
}

function stubFetch({
  role, mailboxesError, identitiesError,
}: {
  role: "admin" | "employee";
  mailboxesError?: string;
  identitiesError?: string;
}) {
  const user = {
    userId: "u1", email: "u1@noxvytop.com", displayName: "U1", role, locale: "es",
  };
  const mailboxes = [
    { id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox", sortOrder: 0, unreadEmails: 0, totalEmails: 0 },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/me")) return new Response(JSON.stringify(user));
    if (url.includes("/api/mail/mailboxes")) {
      return mailboxesError ? jsonError(mailboxesError) : new Response(JSON.stringify(mailboxes));
    }
    if (url.includes("/api/mail/identities")) {
      return identitiesError
        ? jsonError(identitiesError)
        : new Response(JSON.stringify([{ id: "id1", name: "U1", email: "u1@noxvytop.com" }]));
    }
    if (url.includes("/api/mail/preferences")) {
      return new Response(JSON.stringify({ groupMailInMainInbox: false }));
    }
    if (url.includes("/api/mail/messages")) {
      return new Response(JSON.stringify({ total: 0, position: 0, emails: [] }));
    }
    return new Response(JSON.stringify({ status: "ok", checks: {} }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("unlinked mailbox empty state", () => {
  it("shows a neutral onboarding empty state, not an alert, for an admin", async () => {
    stubFetch({ role: "admin", mailboxesError: "mail_credentials_missing" });
    renderAt("/");

    expect(await screen.findByText(i18n.t("mail.unlinked.title"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("mail.unlinked.descriptionAdmin"))).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("gives an admin a CTA link to /admin", async () => {
    stubFetch({ role: "admin", mailboxesError: "mail_credentials_missing" });
    renderAt("/");

    const cta = await screen.findByRole("link", { name: i18n.t("mail.unlinked.cta") });
    expect(cta).toHaveAttribute("href", "/admin");
  });

  it("gives a non-admin a hint instead of a CTA (they cannot self-serve the link)", async () => {
    stubFetch({ role: "employee", mailboxesError: "mail_credentials_missing" });
    renderAt("/");

    expect(await screen.findByText(i18n.t("mail.unlinked.title"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("mail.unlinked.descriptionEmployee"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("mail.unlinked.hint"))).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: i18n.t("mail.unlinked.cta") })).not.toBeInTheDocument();
  });

  it("keeps the generic alert treatment for a real server misconfiguration (mail_not_configured)", async () => {
    stubFetch({ role: "employee", mailboxesError: "mail_not_configured" });
    renderAt("/");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("mail.errors.mail_not_configured"));
    expect(screen.queryByText(i18n.t("mail.unlinked.title"))).not.toBeInTheDocument();
  });
});

describe("CLARO-10: Redactar without identities", () => {
  it("disables the Redactar button when there are no identities", async () => {
    stubFetch({ role: "employee", mailboxesError: "mail_credentials_missing", identitiesError: "mail_credentials_missing" });
    renderAt("/");

    const composeButton = await screen.findByRole("button", { name: i18n.t("composer.title") });
    expect(composeButton).toBeDisabled();
  });

  it("shows a toast hint instead of opening the composer when pressing 'c' with no identities", async () => {
    stubFetch({ role: "employee", mailboxesError: "mail_credentials_missing", identitiesError: "mail_credentials_missing" });
    renderAt("/");

    await screen.findByText(i18n.t("mail.unlinked.title"));
    fireEvent.keyDown(window, { key: "c" });

    expect(await screen.findByRole("status")).toHaveTextContent(i18n.t("composer.noIdentitiesHint"));
    expect(screen.queryByRole("dialog", { name: i18n.t("composer.newMessage") })).not.toBeInTheDocument();
  });

  it("keeps Redactar enabled and 'c' opens the composer when identities are present", async () => {
    stubFetch({ role: "employee" });
    renderAt("/");

    const composeButton = await screen.findByRole("button", { name: i18n.t("composer.title") });
    // The button starts disabled while identities are still loading — wait
    // for the identities query to resolve before asserting the enabled state.
    await vi.waitFor(() => expect(composeButton).not.toBeDisabled());

    fireEvent.keyDown(window, { key: "c" });

    expect(await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") })).toBeInTheDocument();
  });
});
