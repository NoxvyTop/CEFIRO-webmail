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

  // #348: App.tsx's own "?" handler is gated by isPlainShortcut(), which
  // returns false while this overlay's own role="dialog" is open — so the
  // global handler that OPENED it can never be the one that closes it again.
  // The overlay must own its own "?" handling instead.
  it("calls onClose on '?' as well as Escape", () => {
    const onClose = vi.fn();
    render(<ShortcutsOverlay open={true} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "?" });
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

// GH #226: the card was a hard w-[400px] with no cap, so on a 375px phone it
// was wider than the screen and its right-hand key column sat off it.
describe("ShortcutsOverlay at a narrow viewport (GH #226)", () => {
  it("caps the card at the viewport width instead of a fixed 400px", () => {
    render(<ShortcutsOverlay open={true} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog");
    const classes = dialog.className.split(/\s+/);
    expect(classes).toContain("max-w-[400px]");
    expect(classes).toContain("w-full");
    // The uncapped fixed width the issue is about — checked as a whole class
    // token, since "max-w-[400px]" contains it as a substring.
    expect(classes).not.toContain("w-[400px]");
  });

  it("pads the backdrop so the capped card never touches the screen edges", () => {
    render(<ShortcutsOverlay open={true} onClose={vi.fn()} />);

    const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
    expect(backdrop.className).toContain("p-6");
  });

  it("still shows every shortcut row at 375px", () => {
    render(<ShortcutsOverlay open={true} onClose={vi.fn()} />);

    for (const key of ["j", "k", "e", "s", "r", "c", "/", "Esc"]) {
      expect(screen.getByText(key)).toBeVisible();
    }
  });
});
