import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { ProfileView, SessionUser, UpdateProfileInput } from "@webmail/shared";
import { ProfileSettings } from "./ProfileSettings";

const { fetchProfile, updateProfile } = vi.hoisted(() => ({
  fetchProfile: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("./api", () => ({ fetchProfile, updateProfile }));

function pngFile(name: string, byteLength: number, type = "image/png"): File {
  return new File([new Uint8Array(byteLength)], name, { type });
}

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

function stubAuthFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/auth/me")) return new Response(JSON.stringify(sessionUser));
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
}

function renderSettings(initialProfile: ProfileView = profile) {
  fetchProfile.mockResolvedValue(initialProfile);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProfileSettings />
    </QueryClientProvider>,
  );
  return client;
}

describe("ProfileSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubAuthFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the current display name and initials when there is no photo", async () => {
    renderSettings();

    expect(await screen.findByLabelText(i18n.t("settings.displayName"))).toHaveValue(
      "Carla Bosch",
    );
    expect(screen.getByText("CB")).toBeInTheDocument();
  });

  it("renders the current photo instead of initials when avatarDataUrl is set", async () => {
    renderSettings({ ...profile, avatarDataUrl: "data:image/png;base64,AAAA" });

    await screen.findByLabelText(i18n.t("settings.displayName"));
    const img = document.body.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(screen.queryByText("CB")).not.toBeInTheDocument();
  });

  // GH #272: a failed load used to `return null` — a blank panel with no sign
  // of the failure and no retry. It now shows #250's load-error language, and
  // the retry recovers into the form.
  it("shows a retry instead of a blank panel when the profile cannot be loaded", async () => {
    const { MailApiError } = await import("../mailbox/api");
    fetchProfile.mockRejectedValueOnce(new MailApiError(503, "database_unavailable"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ProfileSettings />
      </QueryClientProvider>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("settings.errors.generic"));
    expect(screen.queryByLabelText(i18n.t("settings.displayName"))).not.toBeInTheDocument();

    fetchProfile.mockResolvedValue(profile);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.retry") }));

    expect(await screen.findByLabelText(i18n.t("settings.displayName"))).toBeInTheDocument();
  });

  it("editing the name and saving triggers a PATCH with the new displayName only", async () => {
    updateProfile.mockResolvedValueOnce({ ...profile, displayName: "New Name" });
    renderSettings();

    const nameInput = await screen.findByLabelText(i18n.t("settings.displayName"));
    fireEvent.change(nameInput, { target: { value: "New Name" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({ displayName: "New Name" });
  });

  it("selecting a valid image file and saving triggers a PATCH with the new avatar data URL only", async () => {
    updateProfile.mockResolvedValueOnce({
      ...profile,
      avatarDataUrl: "data:image/png;base64,BBBB",
    });
    renderSettings();

    await screen.findByLabelText(i18n.t("settings.displayName"));
    const fileInput = screen.getByLabelText(i18n.t("settings.photo")) as HTMLInputElement;
    // #348: DevTools warns "A form field element should have an id or name
    // attribute" — this file input, inside a real <form>, had neither.
    expect(fileInput).toHaveAttribute("name", "avatar");
    const file = pngFile("avatar.png", 10, "image/png");
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(document.body.querySelector("img")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    const input = updateProfile.mock.calls[0]?.[0] as UpdateProfileInput;
    expect(input.avatar).toMatch(/^data:image\/png;base64,/);
    expect(input.displayName).toBeUndefined();
  });

  it("rejects an unsupported file type without inserting or saving", async () => {
    renderSettings();

    await screen.findByLabelText(i18n.t("settings.displayName"));
    const fileInput = screen.getByLabelText(i18n.t("settings.photo")) as HTMLInputElement;
    const svg = pngFile("evil.svg", 10, "image/svg+xml");
    fireEvent.change(fileInput, { target: { files: [svg] } });

    expect(await screen.findByText(i18n.t("settings.errors.imageInvalidType"))).toBeInTheDocument();
    expect(document.body.querySelector("img")).toBeNull();
  });

  it("rejects a file over the ~1 MiB cap without inserting or saving", async () => {
    renderSettings();

    await screen.findByLabelText(i18n.t("settings.displayName"));
    const fileInput = screen.getByLabelText(i18n.t("settings.photo")) as HTMLInputElement;
    const oversized = pngFile("huge.png", 2_000_000, "image/png");
    fireEvent.change(fileInput, { target: { files: [oversized] } });

    expect(await screen.findByText(i18n.t("settings.errors.imageTooLarge"))).toBeInTheDocument();
    expect(document.body.querySelector("img")).toBeNull();
  });

  it("a remove photo action triggers a PATCH with avatar: null", async () => {
    updateProfile.mockResolvedValueOnce({ ...profile, avatarDataUrl: null });
    renderSettings({ ...profile, avatarDataUrl: "data:image/png;base64,AAAA" });

    await screen.findByLabelText(i18n.t("settings.displayName"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.removePhoto") }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({ avatar: null });
  });

  it("invalidates the profile and auth/me queries after a successful save", async () => {
    updateProfile.mockResolvedValueOnce({ ...profile, displayName: "New Name" });
    fetchProfile.mockResolvedValue(profile);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <ProfileSettings />
      </QueryClientProvider>,
    );

    const nameInput = await screen.findByLabelText(i18n.t("settings.displayName"));
    fireEvent.change(nameInput, { target: { value: "New Name" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["profile"] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["auth", "me"] });
  });
});
