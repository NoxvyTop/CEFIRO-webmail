import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../i18n";
import i18n from "../i18n";
import { PanelError } from "./PanelError";

// GH #345: MailPage's mailbox list, MessageList's message list and
// ThreadView's reader each rendered a bare `<p role="alert">` with no way to
// retry the query that failed — this is the one shared replacement,
// modeled on settings/PanelStates.tsx's SettingsLoadError.
describe("PanelError (GH #345)", () => {
  it("renders the message as an alert and calls onRetry when the button is clicked", () => {
    const onRetry = vi.fn();
    render(<PanelError message="Something broke" onRetry={onRetry} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something broke");

    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.retry") }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
