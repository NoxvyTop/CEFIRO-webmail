import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type {
  FilterRule,
  ProfileView,
  SessionUser,
  Signature,
  VacationSettings as VacationSettingsData,
} from "@webmail/shared";
import { SettingsPage } from "./SettingsPage";
import { MailApiError } from "../mailbox/api";
import { expectNoAxeViolations } from "../../test/axe";

const { fetchSignatures } = vi.hoisted(() => ({
  fetchSignatures: vi.fn(),
}));

vi.mock("../composer/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composer/api")>();
  return { ...actual, fetchSignatures };
});

const {
  fetchFilterRules,
  fetchFilterSyncState,
  fetchVacationSettings,
  fetchProfile,
  fetchSieveRawScript,
} = vi.hoisted(() => ({
  fetchFilterRules: vi.fn(),
  fetchFilterSyncState: vi.fn(),
  fetchVacationSettings: vi.fn(),
  fetchProfile: vi.fn(),
  // GH #23: read by the Filters and Vacation panels on load. Stubbed here for
  // the same reason every other fetcher is — so switching sections in this
  // page-level test does not reach for a real endpoint.
  fetchSieveRawScript: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchFilterRules,
    fetchFilterSyncState,
    fetchVacationSettings,
    fetchProfile,
    fetchSieveRawScript,
  };
});

const { fetchMailboxes } = vi.hoisted(() => ({ fetchMailboxes: vi.fn() }));

vi.mock("../mailbox/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mailbox/api")>();
  return { ...actual, fetchMailboxes };
});

// GH #124: the new Contacts section — stubbed the same way the other
// sections' data fetchers are above, so switching to it doesn't hit a real
// endpoint.
const { fetchContacts } = vi.hoisted(() => ({ fetchContacts: vi.fn() }));

vi.mock("../contacts/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contacts/api")>();
  return { ...actual, fetchContacts };
});

const signature: Signature = { id: "sig1", name: "Principal", contentHtml: "<p>Hi</p>", isDefault: true };

const filterRule: FilterRule = {
  id: "f1",
  position: 0,
  name: "invoices",
  matchType: "all",
  conditions: [{ field: "from", op: "contains", value: "billing@" }],
  actions: [{ type: "seen" }],
  enabled: true,
};

const vacation: VacationSettingsData = {
  enabled: false,
  subject: "",
  message: "Back soon",
  startsAt: null,
  endsAt: null,
  intervalDays: 7,
};

const profile: ProfileView = {
  displayName: "Carla Bosch",
  email: "carla@noxvytop.com",
  avatarDataUrl: null,
};

// useProfile() (reused by ProfileSettings) gates on the authenticated user
// via useAuth(), which hits /api/auth/me directly — stub it so the profile
// query is actually enabled in these tests.
const sessionUser: SessionUser = {
  userId: "u1",
  email: profile.email,
  displayName: profile.displayName,
  role: "employee",
  locale: "es",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage() {
  fetchSignatures.mockResolvedValue([signature]);
  fetchFilterRules.mockResolvedValue([filterRule]);
  // GH #254: the filters panel now reads the Sieve sync state on load; a
  // synced state is the "nothing to warn about" baseline for these tests.
  fetchFilterSyncState.mockResolvedValue({
    status: "synced",
    attempts: 0,
    lastError: null,
    updatedAt: "2026-07-01T10:00:00.000Z",
  });
  fetchVacationSettings.mockResolvedValue(vacation);
  fetchProfile.mockResolvedValue(profile);
  fetchMailboxes.mockResolvedValue([]);
  fetchContacts.mockResolvedValue([]);
  // GH #23: the rule builder still owns the Sieve script — the baseline where
  // what these panels show is also what runs.
  fetchSieveRawScript.mockResolvedValue({ mode: "rules", script: "", updatedAt: null });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/auth/me")) return new Response(JSON.stringify(sessionUser));
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

describe("SettingsPage sectioned console", () => {
  it("defaults to the Perfil section, and hides other sections' content", async () => {
    renderPage();

    const nav = await screen.findByRole("navigation", { name: i18n.t("settings.nav.label") });
    expect(within(nav).getByRole("button", { name: i18n.t("settings.nav.profile") })).toHaveAttribute(
      "aria-current",
      "page",
    );

    expect(await screen.findByRole("heading", { name: i18n.t("settings.profile") })).toBeInTheDocument();
    expect(await screen.findByLabelText(i18n.t("settings.displayName"))).toHaveValue("Carla Bosch");

    expect(screen.queryByRole("heading", { name: i18n.t("settings.signatures") })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: i18n.t("filters.title") })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: i18n.t("vacation.title") })).not.toBeInTheDocument();
  });

  it("switches to Firmas and shows the sole signature's editor open (#132 edit-first view)", async () => {
    renderPage();

    await screen.findByLabelText(i18n.t("settings.displayName"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.nav.signatures") }));

    expect(await screen.findByRole("heading", { name: i18n.t("settings.signatures") })).toBeInTheDocument();
    // Only one signature is loaded, so per #132 the edit-first view shows its
    // editor open (name as the input's value) instead of a list.
    expect(await screen.findByLabelText(i18n.t("settings.name"))).toHaveValue("Principal");
    expect(screen.queryByRole("heading", { name: i18n.t("settings.profile") })).not.toBeInTheDocument();
  });

  it("switches to Filtros and shows the existing filter rules list", async () => {
    renderPage();

    await screen.findByLabelText(i18n.t("settings.displayName"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.nav.filters") }));

    expect(await screen.findByRole("heading", { name: i18n.t("filters.title") })).toBeInTheDocument();
    expect(await screen.findByText("invoices")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: i18n.t("settings.profile") })).not.toBeInTheDocument();
  });

  it("switches to Ausencia and shows the vacation form", async () => {
    renderPage();

    await screen.findByLabelText(i18n.t("settings.displayName"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.nav.vacation") }));

    expect(await screen.findByRole("heading", { name: i18n.t("vacation.title") })).toBeInTheDocument();
    expect(await screen.findByLabelText(i18n.t("vacation.message"))).toHaveValue("Back soon");
    expect(screen.queryByRole("heading", { name: i18n.t("settings.profile") })).not.toBeInTheDocument();
  });

  it("switches to Contactos and shows the contacts section (#124)", async () => {
    renderPage();
    // renderPage() stubs fetchContacts to [] by default (like every other
    // section's fetcher above) — override it after, with a contact to assert
    // on, same ordering the other section-specific tests don't need since
    // they only assert on renderPage()'s own defaults.
    fetchContacts.mockResolvedValue([
      { id: "c1", name: "Ana Lopez", email: "ana@example.com", source: "manual" },
    ]);

    await screen.findByLabelText(i18n.t("settings.displayName"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.nav.contacts") }));

    expect(await screen.findByRole("heading", { name: i18n.t("contacts.title") })).toBeInTheDocument();
    expect(await screen.findByText("Ana Lopez")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: i18n.t("settings.profile") })).not.toBeInTheDocument();
  });

  // GH #129: the console previously capped itself to max-w-3xl and centred
  // with mx-auto, wasting most of the viewport on wide screens. It should
  // now follow the same full-width layout precedent as AdminPage.tsx.
  it("renders the console at full width, matching the admin console's layout (#129)", async () => {
    renderPage();

    await screen.findByLabelText(i18n.t("settings.displayName"));
    const main = screen.getByRole("main");
    expect(main.className).not.toContain("max-w-3xl");
    expect(main.className).not.toContain("mx-auto");
  });
});

// GH #226: below md the nav is a single horizontal row, and the five Spanish
// tabs need ~440px — more than a 375px phone has. Without wrapping (or
// scrolling) the last ones were simply clipped off the screen with no way to
// reach them.
describe("SettingsPage nav at a narrow viewport (GH #226)", () => {
  const NARROW_VIEWPORT_WIDTH = 375;
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: NARROW_VIEWPORT_WIDTH,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: originalInnerWidth,
      configurable: true,
      writable: true,
    });
  });

  it("lets the tab row wrap below md instead of overflowing off-screen", async () => {
    renderPage();

    const nav = await screen.findByRole("navigation", { name: i18n.t("settings.nav.label") });
    expect(nav.className).toContain("flex-wrap");
    // …and goes back to a plain single column from md up, where the nav is
    // vertical and wrapping would have nothing to do.
    expect(nav.className).toContain("md:flex-col");
    expect(nav.className).toContain("md:flex-nowrap");
  });

  it("keeps all five sections present and reachable", async () => {
    renderPage();

    const nav = await screen.findByRole("navigation", { name: i18n.t("settings.nav.label") });
    for (const labelKey of [
      "settings.nav.profile",
      "settings.nav.signatures",
      "settings.nav.filters",
      "settings.nav.vacation",
      "settings.nav.contacts",
    ]) {
      expect(within(nav).getByRole("button", { name: i18n.t(labelKey) })).toBeVisible();
    }

    fireEvent.click(within(nav).getByRole("button", { name: i18n.t("settings.nav.contacts") }));
    expect(
      await screen.findByRole("heading", { name: i18n.t("contacts.title") }),
    ).toBeInTheDocument();
  });
});

// GH #252: the settings console has five independently-rendered sections, and
// #250's new loading/failed states added two more things to get wrong in each.
// Walking every section with the real axe engine costs one test and covers
// what nobody remembered to assert by hand.
describe("settings screen accessibility (GH #252)", () => {
  it.each([
    ["settings.nav.profile", "settings.profile"],
    ["settings.nav.signatures", "settings.signatures"],
    ["settings.nav.filters", "filters.title"],
    ["settings.nav.vacation", "vacation.title"],
    ["settings.nav.contacts", "contacts.title"],
  ])("passes an axe run over the %s section", async (navKey, headingKey) => {
    renderPage();

    const nav = await screen.findByRole("navigation", { name: i18n.t("settings.nav.label") });
    fireEvent.click(within(nav).getByRole("button", { name: i18n.t(navKey) }));
    await screen.findByRole("heading", { name: i18n.t(headingKey) });

    await expectNoAxeViolations(document.body);
  });

  it("passes an axe run over a section whose load failed (GH #250)", async () => {
    renderPage();
    fetchFilterRules.mockRejectedValue(new MailApiError(503, "database_unavailable"));

    const nav = await screen.findByRole("navigation", { name: i18n.t("settings.nav.label") });
    fireEvent.click(within(nav).getByRole("button", { name: i18n.t("settings.nav.filters") }));

    await screen.findByRole("alert");
    await expectNoAxeViolations(document.body);
  });
});
