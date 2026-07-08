import { describe, expect, it } from "vitest";
import { isPlainShortcut, isTypingTarget } from "./shortcuts";

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
});
