import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { ActiveSession } from "@webmail/shared";
import { MailApiError } from "../mailbox/api";
import { SessionsSettings, deviceLabel } from "./SessionsSettings";

const { fetchSessions, revokeSession, revokeOtherSessions } = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
}));

vi.mock("./api", () => ({ fetchSessions, revokeSession, revokeOtherSessions }));

beforeEach(() => {
  vi.clearAllMocks();
});

const NOW = "2026-08-04T10:00:00.000Z";

const current: ActiveSession = {
  id: "s-current",
  current: true,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  ip: "203.0.113.5",
  createdAt: NOW,
  lastSeenAt: NOW,
  expiresAt: "2026-08-05T10:00:00.000Z",
};

const other: ActiveSession = {
  id: "s-other",
  current: false,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/604.1",
  ip: "198.51.100.9",
  createdAt: NOW,
  lastSeenAt: NOW,
  expiresAt: "2026-08-05T10:00:00.000Z",
};

function renderSettings(sessions: ActiveSession[] = [current, other]) {
  fetchSessions.mockResolvedValue(sessions);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionsSettings />
    </QueryClientProvider>,
  );
  return client;
}

describe("deviceLabel", () => {
  it("derives a coarse browser · OS label", () => {
    expect(deviceLabel(current.userAgent)).toBe("Chrome · Windows");
    expect(deviceLabel(other.userAgent)).toBe("Safari · iOS");
  });

  it("returns null for an empty or unrecognizable user agent", () => {
    expect(deviceLabel(null)).toBeNull();
    expect(deviceLabel("some-bespoke-cli/1.0")).toBeNull();
  });
});

describe("SessionsSettings", () => {
  it("lists sessions with their device, flags the current one, and shows the IP", async () => {
    renderSettings([current, other]);

    expect(await screen.findByText("Chrome · Windows")).toBeInTheDocument();
    expect(screen.getByText("Safari · iOS")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("settings.sessions.current"))).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t("settings.sessions.location", { ip: "203.0.113.5" })),
    ).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t("settings.sessions.location", { ip: "198.51.100.9" })),
    ).toBeInTheDocument();
  });

  it("shows the unknown-device fallback for a session with no user agent", async () => {
    renderSettings([current, { ...other, userAgent: null }]);

    expect(await screen.findByText(i18n.t("settings.sessions.unknownDevice"))).toBeInTheDocument();
  });

  it("offers Close only on non-current sessions", async () => {
    renderSettings([current, other]);

    await screen.findByText("Chrome · Windows");
    // Exactly one per-session Close (on the non-current row); the current row
    // shows the badge instead.
    expect(screen.getAllByRole("button", { name: i18n.t("settings.sessions.close") })).toHaveLength(1);
  });

  it("revokes one session and refetches the list", async () => {
    revokeSession.mockResolvedValueOnce(undefined);
    renderSettings([current, other]);

    await screen.findByText("Safari · iOS");
    fetchSessions.mockResolvedValue([current]);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.sessions.close") }));

    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith("s-other"));
    await waitFor(() => expect(screen.queryByText("Safari · iOS")).not.toBeInTheDocument());
    expect(screen.getByText("Chrome · Windows")).toBeInTheDocument();
  });

  it("closes every other session via the bulk action, after confirming", async () => {
    revokeOtherSessions.mockResolvedValueOnce(1);
    renderSettings([current, other]);

    await screen.findByText("Safari · iOS");
    fetchSessions.mockResolvedValue([current]);
    // #348: a bulk destructive action — first click only asks for
    // confirmation (two-step confirm, matching Sidebar's label delete).
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.sessions.closeOthers") }));
    expect(revokeOtherSessions).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("settings.sessions.confirmCloseOthersAction") }),
    );

    await waitFor(() => expect(revokeOtherSessions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("Safari · iOS")).not.toBeInTheDocument());
  });

  it("cancels the close-others confirmation without revoking anything", async () => {
    renderSettings([current, other]);

    await screen.findByText("Safari · iOS");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.sessions.closeOthers") }));
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("settings.sessions.cancelCloseOthers") }),
    );

    expect(revokeOtherSessions).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: i18n.t("settings.sessions.closeOthers") }),
    ).toBeInTheDocument();
  });

  it("hides the bulk action and any Close button when only the current session exists", async () => {
    renderSettings([current]);

    await screen.findByText("Chrome · Windows");
    expect(
      screen.queryByRole("button", { name: i18n.t("settings.sessions.closeOthers") }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: i18n.t("settings.sessions.close") }),
    ).not.toBeInTheDocument();
  });

  it("shows a load error with a retry when the list cannot be fetched", async () => {
    fetchSessions.mockRejectedValue(new MailApiError(503, "database_unavailable"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SessionsSettings />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("settings.retry") })).toBeInTheDocument();
  });

  it("surfaces a failed revoke inline without dropping the list", async () => {
    revokeSession.mockRejectedValueOnce(new MailApiError(500, "internal"));
    renderSettings([current, other]);

    await screen.findByText("Safari · iOS");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.sessions.close") }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // The list is still there — a failed revoke leaves it in place.
    expect(screen.getByText("Safari · iOS")).toBeInTheDocument();
  });
});
