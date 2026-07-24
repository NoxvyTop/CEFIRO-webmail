import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
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

const { fetchSignatures } = vi.hoisted(() => ({
  fetchSignatures: vi.fn(),
}));

vi.mock("../composer/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composer/api")>();
  return { ...actual, fetchSignatures };
});

const { fetchFilterRules, fetchVacationSettings, fetchProfile } = vi.hoisted(() => ({
  fetchFilterRules: vi.fn(),
  fetchVacationSettings: vi.fn(),
  fetchProfile: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchFilterRules, fetchVacationSettings, fetchProfile };
});

const { fetchMailboxes } = vi.hoisted(() => ({ fetchMailboxes: vi.fn() }));

vi.mock("../mailbox/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mailbox/api")>();
  return { ...actual, fetchMailboxes };
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
  fetchVacationSettings.mockResolvedValue(vacation);
  fetchProfile.mockResolvedValue(profile);
  fetchMailboxes.mockResolvedValue([]);
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

  it("switches to Firmas and shows the existing signatures list", async () => {
    renderPage();

    await screen.findByLabelText(i18n.t("settings.displayName"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.nav.signatures") }));

    expect(await screen.findByRole("heading", { name: i18n.t("settings.signatures") })).toBeInTheDocument();
    expect(await screen.findByText("Principal")).toBeInTheDocument();
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
});
