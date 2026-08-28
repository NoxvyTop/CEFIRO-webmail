import { useEffect, useRef, type RefObject } from "react";

// Every role a WAI-ARIA menu item can carry — mirrors this codebase's own
// menus: UserMenu.tsx's plain menuitem links/buttons and ThreadView.tsx's
// label picker, which uses menuitemcheckbox for its toggleable labels.
const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/**
 * Keyboard behavior for a `role="menu"` popup: focuses its first item the
 * moment it opens, and lets ArrowUp/ArrowDown/Home/End move focus among its
 * items (wrapping at the ends) — the behavior WAI-ARIA's menu pattern
 * specifies and every native OS menu already has.
 *
 * #348: UserMenu.tsx and ThreadView.tsx's label picker both render
 * `role="menu"` with `role="menuitem"`/`menuitemcheckbox"` children, but
 * neither moved focus in on open or wired up arrow keys — a keyboard user
 * had to Tab in from wherever focus already was and could not navigate
 * between items at all. Deliberately narrower than useFocusTrap: a menu
 * closes itself entirely on outside click/Escape (each caller already
 * handles that), so this only owns the item-to-item navigation, not
 * activation/restoration or Tab-cycling.
 *
 * Returns a ref to attach to the menu's own `role="menu"` element — or, if
 * the caller already has one (ThreadView.tsx's label menu needs its own ref
 * for click-outside detection on a portaled element), pass it as `existingRef`
 * so both concerns share the one DOM node instead of racing two refs for it.
 */
export function useMenuKeyboardNav<T extends HTMLElement>(
  active: boolean,
  existingRef?: RefObject<T | null>,
): RefObject<T | null> {
  const internalRef = useRef<T>(null);
  const containerRef = existingRef ?? internalRef;

  // Moves focus onto the first item the moment the menu opens.
  useEffect(() => {
    if (!active) return;
    containerRef.current?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)?.focus();
  }, [active]);

  // ArrowUp/ArrowDown/Home/End move focus among the menu's items.
  useEffect(() => {
    if (!active) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const container = containerRef.current;
      if (!container) return;
      const items = Array.from(container.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
      if (items.length === 0) return;

      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      let nextIndex: number;
      if (event.key === "ArrowDown") {
        nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
      } else if (event.key === "ArrowUp") {
        nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else {
        nextIndex = items.length - 1;
      }
      event.preventDefault();
      items[nextIndex]?.focus();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active]);

  return containerRef;
}
