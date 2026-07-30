import { afterEach, describe, expect, it } from "vitest";
import { isModalOpen, isPlainShortcut, isTypingTarget, MODAL_SELECTOR } from "./shortcuts";

function keydownEvent(key: string, target: EventTarget, overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...overrides });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

describe("isTypingTarget", () => {
  it("returns true for an input element", () => {
    const input = document.createElement("input");
    expect(isTypingTarget(keydownEvent("j", input))).toBe(true);
  });

  it("returns true for a textarea element", () => {
    const textarea = document.createElement("textarea");
    expect(isTypingTarget(keydownEvent("j", textarea))).toBe(true);
  });

  it("returns true for a select element", () => {
    const select = document.createElement("select");
    expect(isTypingTarget(keydownEvent("j", select))).toBe(true);
  });

  it("returns true for a contentEditable element", () => {
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(isTypingTarget(keydownEvent("j", div))).toBe(true);
  });

  it("returns false for the body element", () => {
    expect(isTypingTarget(keydownEvent("j", document.body))).toBe(false);
  });

  it("returns false for a button element", () => {
    const button = document.createElement("button");
    expect(isTypingTarget(keydownEvent("j", button))).toBe(false);
  });
});

describe("isPlainShortcut", () => {
  it("returns true for a plain key on the body", () => {
    expect(isPlainShortcut(keydownEvent("j", document.body))).toBe(true);
  });

  it("returns false when ctrlKey is pressed", () => {
    expect(isPlainShortcut(keydownEvent("j", document.body, { ctrlKey: true }))).toBe(false);
  });

  it("returns false when metaKey is pressed", () => {
    expect(isPlainShortcut(keydownEvent("j", document.body, { metaKey: true }))).toBe(false);
  });

  it("returns false when altKey is pressed", () => {
    expect(isPlainShortcut(keydownEvent("j", document.body, { altKey: true }))).toBe(false);
  });

  it("returns false when the event is already defaultPrevented", () => {
    const event = keydownEvent("j", document.body);
    event.preventDefault();
    expect(isPlainShortcut(event)).toBe(false);
  });

  it("returns false for a typing target", () => {
    const input = document.createElement("input");
    expect(isPlainShortcut(keydownEvent("j", input))).toBe(false);
  });

  it("returns false when a dialog is open in the DOM", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    try {
      expect(isPlainShortcut(keydownEvent("j", document.body))).toBe(false);
    } finally {
      dialog.remove();
    }
  });
});

describe("isModalOpen", () => {
  afterEach(() => {
    Array.from(document.querySelectorAll(MODAL_SELECTOR)).forEach((el) => el.remove());
  });

  it("returns false when no dialog is present", () => {
    expect(isModalOpen()).toBe(false);
  });

  it("returns true when a dialog element is appended to the DOM", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    expect(isModalOpen()).toBe(true);
  });

  // GH #161: the permanent-delete confirmation uses role="alertdialog", not
  // "dialog" — isModalOpen() must recognize it too, or single-key shortcuts
  // (r, c, ...) keep firing underneath an irreversible-action confirmation.
  it("returns true when only an alertdialog element is present", () => {
    const alertdialog = document.createElement("div");
    alertdialog.setAttribute("role", "alertdialog");
    document.body.appendChild(alertdialog);
    expect(isModalOpen()).toBe(true);
  });
});

describe("MODAL_SELECTOR", () => {
  // GH #161: shortcuts.ts's isModalOpen() and Composer.tsx's own nested-
  // overlay Escape check both answer "is there a modal-owning overlay here"
  // — MODAL_SELECTOR is the single definition both consume, so the two never
  // drift again the way isModalOpen (dialog only) and Composer's own check
  // (dialog + alertdialog) had.
  it("matches both dialog and alertdialog roles", () => {
    expect(MODAL_SELECTOR).toContain('[role="dialog"]');
    expect(MODAL_SELECTOR).toContain('[role="alertdialog"]');
  });
});
