import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { AUTH_ERROR_CODES } from "@webmail/shared";
import i18n from "../../app/i18n";
import { errorMessageKey } from "../../app/errorMessages";
import { routes } from "../../app/routes";

const LANGUAGES = ["es", "en"];

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await i18n.changeLanguage("es");
});

// GH #232, the walk the issue asks for. A failed OIDC login is a redirect, and a
// redirect carries no ApiError envelope — so a code the login screen does not
// recognise is not a bad message, it is NO message: the user lands back on the
// form, sees that "nothing happened", and retries the sign-in that just refused
// them. That is what an archived account got. AUTH_ERROR_CODES in
// @webmail/shared is the server's own list (apps/server/src/modules/auth/
// router.ts redirects through it), so this fails the moment a new cause is
// added there without a message here.
describe("auth_error code coverage (GH #232)", () => {
  for (const language of LANGUAGES) {
    it.each(AUTH_ERROR_CODES)(`${language}: %s resolves to a real message`, async (code) => {
      await i18n.changeLanguage(language);
      const key = errorMessageKey("auth", code);

      expect(i18n.exists(key)).toBe(true);
      const message = i18n.t(key);
      expect(message).not.toBe(key);
      expect(message).not.toContain("auth.errors.");
      expect(message.trim().length).toBeGreaterThan(0);
    });
  }

  it.each(AUTH_ERROR_CODES)("renders a login-screen alert for %s", async (code) => {
    await i18n.changeLanguage("es");
    renderAt(`/?auth_error=${code}`);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.trim()).toBe(i18n.t(errorMessageKey("auth", code)));
    expect(alert.textContent).not.toContain("auth.errors.");
  });
});

describe("the login screen's auth_error banner", () => {
  it("names the archived account instead of showing nothing (GH #232)", async () => {
    renderAt("/?auth_error=account_archived");

    expect(
      await screen.findByText(i18n.t("auth.errors.account_archived")),
    ).toBeInTheDocument();
    // The point of the issue: the message must be specific, not the catch-all.
    expect(i18n.t("auth.errors.account_archived")).not.toBe(i18n.t("auth.errors.generic"));
  });

  it("names an unverified IdP address, which is the one cause the user can fix (GH #46)", async () => {
    renderAt("/?auth_error=oidc_email_unverified");

    expect(
      await screen.findByText(i18n.t("auth.errors.oidc_email_unverified")),
    ).toBeInTheDocument();
    expect(i18n.t("auth.errors.oidc_email_unverified")).not.toBe(i18n.t("auth.errors.generic"));
  });

  // A code from a future server, or one somebody typed into the URL bar. The
  // old allowlist rendered nothing at all for these; the bundle-backed map
  // falls back to the generic message, which is still an answer.
  it("falls back to the generic message for a code it has never seen", async () => {
    renderAt("/?auth_error=something_nobody_translated");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.trim()).toBe(i18n.t("auth.errors.generic"));
  });

  it("shows no banner at all when there is no auth_error", async () => {
    renderAt("/");

    expect(await screen.findByText(i18n.t("auth.signIn"))).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
