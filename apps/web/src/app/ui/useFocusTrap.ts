import { useEffect, useRef, type RefObject } from "react";

// Elements a Tab-based focus trap should cycle through — the same "visible
// and operable" focusable selector every one of this codebase's six modal
// surfaces already used before this hook existed (ShortcutsOverlay,
// AttachmentViewer, Composer's DiscardConfirmDialog, ThreadView's
// DeletePermanentlyConfirmDialog — copy-pasted four times over).
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Marks a keyboard-owning overlay boundary — mirrors shortcuts.ts's
// MODAL_SELECTOR (GH #161). Used here so a trap never fights a NESTED
// dialog layered on top of it: see isOwnedByNestedDialog below.
const NESTED_DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';

// True when a dialog-role element sits strictly BETWEEN `element` and
// `container` — i.e. `element` belongs to a dialog nested deeper inside
// `container`'s own subtree, not to `container` itself.
//
// This is deliberately a tree WALK from `element` up to `container`, not
// `element.closest(NESTED_DIALOG_SELECTOR) === container`: this codebase's
// six modal surfaces split into two different structures. ShortcutsOverlay/
// AttachmentViewer/Composer's own root put `role="dialog"` on the same
// element the trap ref is attached to. NewLabelModal/DiscardConfirmDialog/
// DeletePermanentlyConfirmDialog put the role on a separate outer backdrop
// element (so a backdrop click can dismiss without also matching the inner
// panel's own stopPropagation handler) and the trap ref on the inner panel
// — for those, `closest()` from any focusable element finds that OUTER
// backdrop, never `container` itself, which would make an equality check
// exclude every element and break the trap entirely. Walking only as far as
// `container` sidesteps that: it stops before ever reaching an ancestor
// backdrop, so it only ever reports a TRUE positive for a dialog genuinely
// nested inside `container` (e.g. Composer's own trap vs. its nested
// DiscardConfirmDialog, itself a backdrop-then-panel pair one level down).
function isOwnedByNestedDialog(element: HTMLElement, container: HTMLElement): boolean {
  let node = element.parentElement;
  while (node && node !== container) {
    if (node.matches(NESTED_DIALOG_SELECTOR)) return true;
    node = node.parentElement;
  }
  return false;
}

interface UseFocusTrapOptions {
  /**
   * Element focused when the trap activates, instead of the container
   * itself. Most dialogs want the container (the default — it already
   * carries `role="dialog"`/`"alertdialog"` and an accessible name, so
   * focusing it announces the dialog immediately). NewLabelModal is the one
   * exception in this codebase: its name input is the more natural entry
   * point than the surrounding chrome.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Traps keyboard focus inside a modal dialog while `active` is true: moves
 * focus into the dialog when it activates, cycles Tab/Shift+Tab among its
 * focusable elements, and restores focus to whatever was focused before it
 * activated once it deactivates (or unmounts while still active).
 *
 * GH #158: six modal surfaces in this codebase each reimplemented a slice of
 * this by hand (ShortcutsOverlay.tsx, AttachmentViewer.tsx, NewLabelModal.tsx,
 * Composer.tsx, and its two newest dialogs — Composer's own
 * DiscardConfirmDialog and ThreadView's DeletePermanentlyConfirmDialog).
 * ShortcutsOverlay/AttachmentViewer already had the full Tab-cycling
 * behavior duplicated correctly; NewLabelModal, DiscardConfirmDialog and
 * DeletePermanentlyConfirmDialog moved focus in and restored it but never
 * cycled Tab, so focus walked out of a still-visible overlay into
 * background content once the user reached the last button. A hook (rather
 * than a wrapping component) because each dialog owns its own DOM structure
 * and styling — attaching a ref to an existing element is a drop-in change,
 * while a wrapper component would force every caller to restructure its
 * JSX around children it doesn't control.
 *
 * Returns a ref to attach to the dialog's own outer element — give that
 * element `tabIndex={-1}` and `role="dialog"`/`"alertdialog"` so it is both
 * a valid focus target and recognized as a modal boundary (by this hook's
 * own nested-dialog exclusion below, and by shortcuts.ts's MODAL_SELECTOR).
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  { initialFocusRef }: UseFocusTrapOptions = {},
): RefObject<T | null> {
  const containerRef = useRef<T>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Moves focus in on activation and restores it on deactivation/unmount.
  useEffect(() => {
    if (!active) return;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocusRef?.current ?? containerRef.current)?.focus();

    return () => {
      previouslyFocusedRef.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialFocusRef is a stable ref object, not reactive state
  }, [active]);

  // Cycles Tab/Shift+Tab within the container's focusable elements.
  useEffect(() => {
    if (!active) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;

      // Excludes anything that belongs to a NESTED dialog (e.g. Composer's
      // own trap vs. its nested discard-confirmation trap while both are
      // mounted). Without this, an outer trap would treat a nested dialog's
      // own buttons as part of its boundary and yank focus straight past
      // the nested overlay — the same bug #158 reports, reintroduced at the
      // seam between two traps.
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => !isOwnedByNestedDialog(element, container),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active]);

  return containerRef;
}
