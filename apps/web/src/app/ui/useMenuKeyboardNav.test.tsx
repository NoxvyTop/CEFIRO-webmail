import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMenuKeyboardNav } from "./useMenuKeyboardNav";

function Menu() {
  const menuRef = useMenuKeyboardNav<HTMLDivElement>(true);
  return (
    <div ref={menuRef} role="menu" aria-label="test menu">
      <button type="button" role="menuitem">
        first
      </button>
      <button type="button" role="menuitem">
        middle
      </button>
      <button type="button" role="menuitemcheckbox" aria-checked={false}>
        last
      </button>
    </div>
  );
}

function EmptyMenu() {
  const menuRef = useMenuKeyboardNav<HTMLDivElement>(true);
  return (
    <div ref={menuRef} role="menu" aria-label="empty menu">
      <p>nothing to navigate</p>
    </div>
  );
}

function ToggleHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open menu
      </button>
      {open && <Menu />}
    </div>
  );
}

describe("useMenuKeyboardNav", () => {
  it("focuses the first menu item as soon as the menu opens", () => {
    render(<ToggleHarness />);
    fireEvent.click(screen.getByRole("button", { name: "open menu" }));
    expect(screen.getByRole("menuitem", { name: "first" })).toHaveFocus();
  });

  it("moves focus forward with ArrowDown and wraps past the last item", () => {
    render(<Menu />);
    const first = screen.getByRole("menuitem", { name: "first" });
    const middle = screen.getByRole("menuitem", { name: "middle" });
    const last = screen.getByRole("menuitemcheckbox", { name: "last" });
    first.focus();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(middle).toHaveFocus();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(last).toHaveFocus();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(first).toHaveFocus();
  });

  it("moves focus backward with ArrowUp and wraps before the first item", () => {
    render(<Menu />);
    const first = screen.getByRole("menuitem", { name: "first" });
    const last = screen.getByRole("menuitemcheckbox", { name: "last" });
    first.focus();

    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(last).toHaveFocus();
  });

  it("jumps to the first/last item with Home/End", () => {
    render(<Menu />);
    const first = screen.getByRole("menuitem", { name: "first" });
    const middle = screen.getByRole("menuitem", { name: "middle" });
    const last = screen.getByRole("menuitemcheckbox", { name: "last" });
    middle.focus();

    fireEvent.keyDown(window, { key: "End" });
    expect(last).toHaveFocus();

    fireEvent.keyDown(window, { key: "Home" });
    expect(first).toHaveFocus();
  });

  it("does nothing when the menu has no items to navigate to", () => {
    render(<EmptyMenu />);
    // Just asserts this does not throw when there is nothing focusable.
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getByText("nothing to navigate")).toBeInTheDocument();
  });
});
