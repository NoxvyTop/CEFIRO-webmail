import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../i18n";
import { ShortcutsOverlay } from "./ShortcutsOverlay";

function ToggleHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open shortcuts
      </button>
      <ShortcutsOverlay open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

describe("ShortcutsOverlay", () => {
  it("renders nothing when closed", () => {
    render(<ShortcutsOverlay open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the dialog with the title and all shortcut rows when open", () => {
    render(<ShortcutsOverlay open={true} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Atajos de teclado")).toBeInTheDocument();
    const keys = ["j", "k", "e", "s", "r", "c", "/", "Esc"];
    for (const key of keys) {
      expect(screen.getByText(key)).toBeInTheDocument();
    }
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(<ShortcutsOverlay open={true} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when clicking the backdrop", () => {
    const onClose = vi.fn();
    render(<ShortcutsOverlay open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when clicking inside the card", () => {
    const onClose = vi.fn();
    render(<ShortcutsOverlay open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("declares aria-modal on the dialog", () => {
    render(<ShortcutsOverlay open={true} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("moves focus into the dialog when it opens and restores it to the opener when it closes", async () => {
    render(<ToggleHarness />);
    const trigger = screen.getByRole("button", { name: "open shortcuts" });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps Tab from moving focus outside the dialog when nothing inside is focusable", () => {
    render(<ShortcutsOverlay open={true} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(dialog);
  });
});
