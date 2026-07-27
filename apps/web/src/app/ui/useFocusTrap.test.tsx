import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFocusTrap } from "./useFocusTrap";

// Minimal dialog harness — mirrors ShortcutsOverlay's own pre-existing
// ToggleHarness pattern (shortcuts-overlay.test.tsx), generalized to any
// number of focusable children so the shared primitive can be exercised
// without a specific feature dialog.
function Dialog({ testId = "dialog", onClose }: { testId?: string; onClose?(): void }) {
  const dialogRef = useFocusTrap<HTMLDivElement>(true);
  return (
    <div ref={dialogRef} role="dialog" aria-label="test dialog" tabIndex={-1} data-testid={testId}>
      <button type="button">first</button>
      <button type="button">middle</button>
      <button type="button">last</button>
      {onClose && (
        <button type="button" onClick={onClose}>
          close
        </button>
      )}
    </div>
  );
}

function EmptyDialog() {
  const dialogRef = useFocusTrap<HTMLDivElement>(true);
  return (
    <div ref={dialogRef} role="dialog" aria-label="empty dialog" tabIndex={-1}>
      <p>nothing focusable in here</p>
    </div>
  );
}

function ToggleHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open dialog
      </button>
      {open && <Dialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function NamedFieldDialog() {
  // A real, stable useRef — mirrors NewLabelModal.tsx's own nameInputRef,
  // set during commit (before any passive effect runs), unlike a re-created
  // plain object literal.
  const nameInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useFocusTrap<HTMLDivElement>(true, { initialFocusRef: nameInputRef });
  return (
    <div ref={dialogRef} role="dialog" aria-label="named field dialog" tabIndex={-1}>
      <input ref={nameInputRef} aria-label="name" />
      <button type="button">submit</button>
    </div>
  );
}

// Mirrors Composer.tsx's real shape: an always-active outer trap whose
// container later gains a nested, independently-trapped dialog (the discard
// confirmation) — see GH #158's Composer.tsx surface and its
// DiscardConfirmDialog surface.
function OuterDialog() {
  const [innerOpen, setInnerOpen] = useState(false);
  const outerRef = useFocusTrap<HTMLDivElement>(true);
  return (
    <div ref={outerRef} role="dialog" aria-label="outer" tabIndex={-1} data-testid="outer">
      <button type="button" onClick={() => setInnerOpen(true)}>
        outer-open-inner
      </button>
      <button type="button">outer-last</button>
      {innerOpen && <InnerDialog />}
    </div>
  );
}

function InnerDialog() {
  const innerRef = useFocusTrap<HTMLDivElement>(true);
  return (
    <div ref={innerRef} role="alertdialog" aria-label="inner" tabIndex={-1} data-testid="inner">
      <button type="button">inner-first</button>
      <button type="button">inner-last</button>
    </div>
  );
}

// Mirrors DiscardConfirmDialog/DeletePermanentlyConfirmDialog/NewLabelModal's
// real structure: `role="alertdialog"` sits on an OUTER backdrop element (so
// a backdrop click can dismiss), while the trap's own ref/tabIndex sit on a
// separate INNER panel one level down — unlike ShortcutsOverlay/
// AttachmentViewer, which put the role and the ref on the same element.
function BackdropDialog({ onDismiss }: { onDismiss(): void }) {
  const panelRef = useFocusTrap<HTMLDivElement>(true);
  return (
    <div role="alertdialog" aria-label="backdrop dialog" onClick={onDismiss}>
      <div ref={panelRef} tabIndex={-1} data-testid="panel" onClick={(event) => event.stopPropagation()}>
        <button type="button">panel-first</button>
        <button type="button">panel-last</button>
      </div>
    </div>
  );
}

describe("useFocusTrap", () => {
  it("moves focus into the container when it activates", () => {
    render(<Dialog />);
    expect(document.activeElement).toBe(screen.getByTestId("dialog"));
  });

  it("restores focus to the previously focused element once the trapped component unmounts", async () => {
    render(<ToggleHarness />);
    const trigger = screen.getByRole("button", { name: "open dialog" });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const dialog = await screen.findByTestId("dialog");
    expect(document.activeElement).toBe(dialog);

    // Unmounting is how Composer's DiscardConfirmDialog, ThreadView's
    // DeletePermanentlyConfirmDialog, and NewLabelModal all close — there is
    // no `open` prop, the component is conditionally rendered instead.
    fireEvent.click(screen.getByRole("button", { name: "close" }));

    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("cycles Tab from the last focusable element back to the first", () => {
    render(<Dialog />);
    const last = screen.getByRole("button", { name: "last" });
    last.focus();

    fireEvent.keyDown(window, { key: "Tab" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "first" }));
  });

  it("cycles Shift+Tab from the first focusable element back to the last", () => {
    render(<Dialog />);
    const first = screen.getByRole("button", { name: "first" });
    first.focus();

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "last" }));
  });

  it("does not move focus when Tab is pressed away from either boundary", () => {
    render(<Dialog />);
    const middle = screen.getByRole("button", { name: "middle" });
    middle.focus();

    fireEvent.keyDown(window, { key: "Tab" });

    // Left to the browser's native tab order — the trap only intervenes at
    // the boundaries, exactly like the six hand-rolled implementations it
    // replaces.
    expect(document.activeElement).toBe(middle);
  });

  it("keeps focus pinned to the container when nothing inside is focusable", () => {
    render(<EmptyDialog />);
    const dialog = screen.getByRole("dialog", { name: "empty dialog" });
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
  });

  it("focuses the given initialFocusRef target instead of the container when provided", () => {
    render(<NamedFieldDialog />);
    expect(document.activeElement).toBe(screen.getByLabelText("name"));
  });

  it("excludes a nested dialog's focusable elements from the outer trap's own Tab cycle", () => {
    render(<OuterDialog />);
    fireEvent.click(screen.getByRole("button", { name: "outer-open-inner" }));

    const inner = screen.getByTestId("inner");
    // The inner dialog's own trap claims focus on mount.
    expect(document.activeElement).toBe(inner);

    const innerLast = screen.getByRole("button", { name: "inner-last" });
    innerLast.focus();
    fireEvent.keyDown(window, { key: "Tab" });

    // Must wrap within the INNER dialog, not escape into the outer one's
    // "outer-open-inner" button — this is the exact class of bug #158
    // reports (focus walking past a still-visible overlay), reintroduced at
    // the boundary between two nested traps if the outer one doesn't defer.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "inner-first" }));
  });

  it("still cycles Tab correctly when the dialog role lives on an outer backdrop instead of the ref'd panel", () => {
    render(<BackdropDialog onDismiss={() => {}} />);
    const panel = screen.getByTestId("panel");
    expect(document.activeElement).toBe(panel);

    const last = screen.getByRole("button", { name: "panel-last" });
    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "panel-first" }));
  });
});
