export function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// GH #161: the single definition of "what counts as a keyboard-owning modal
// overlay" — consumed by isModalOpen() below AND by Composer.tsx's own
// nested-overlay Escape check, which used to hand-roll the same two-role
// selector inline. Before this, isModalOpen() only matched role="dialog",
// so the permanent-delete confirmation (role="alertdialog") didn't count as
// a modal at all: single-key shortcuts like "r"/"c" kept firing underneath
// it, right next to an irreversible action.
export const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"]';

export function isModalOpen(): boolean {
  return document.querySelector(MODAL_SELECTOR) !== null;
}

export function isPlainShortcut(event: KeyboardEvent): boolean {
  return (
    !event.defaultPrevented &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !isTypingTarget(event) &&
    !isModalOpen()
  );
}
