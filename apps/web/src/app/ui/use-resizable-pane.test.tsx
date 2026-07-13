import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useResizablePane } from "./useResizablePane";

const STORAGE_KEY = "cefiro-list-width";

function arrowKey(key: "ArrowLeft" | "ArrowRight") {
  return {
    key,
    preventDefault: () => {},
  } as unknown as ReactKeyboardEvent;
}

beforeEach(() => {
  localStorage.clear();
});

describe("useResizablePane", () => {
  it("defaults to 390 when nothing is stored", () => {
    const { result } = renderHook(() => useResizablePane());
    expect(result.current.width).toBe(390);
  });

  it("reads a valid stored width", () => {
    localStorage.setItem(STORAGE_KEY, "420");
    const { result } = renderHook(() => useResizablePane());
    expect(result.current.width).toBe(420);
  });

  it("ignores a garbage stored value and falls back to the default", () => {
    localStorage.setItem(STORAGE_KEY, "not-a-number");
    const { result } = renderHook(() => useResizablePane());
    expect(result.current.width).toBe(390);
  });

  it("ignores an out-of-range stored value and falls back to the default", () => {
    localStorage.setItem(STORAGE_KEY, "999");
    const { result } = renderHook(() => useResizablePane());
    expect(result.current.width).toBe(390);
  });

  it("widens by 16 on ArrowRight and persists", () => {
    const { result } = renderHook(() => useResizablePane());
    act(() => result.current.handleKeyDown(arrowKey("ArrowRight")));
    expect(result.current.width).toBe(406);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("406");
  });

  it("narrows by 16 on ArrowLeft and persists", () => {
    const { result } = renderHook(() => useResizablePane());
    act(() => result.current.handleKeyDown(arrowKey("ArrowLeft")));
    expect(result.current.width).toBe(374);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("374");
  });

  it("clamps at the maximum width of 560", () => {
    localStorage.setItem(STORAGE_KEY, "560");
    const { result } = renderHook(() => useResizablePane());
    act(() => result.current.handleKeyDown(arrowKey("ArrowRight")));
    expect(result.current.width).toBe(560);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("560");
  });

  it("clamps at the minimum width of 280", () => {
    localStorage.setItem(STORAGE_KEY, "280");
    const { result } = renderHook(() => useResizablePane());
    act(() => result.current.handleKeyDown(arrowKey("ArrowLeft")));
    expect(result.current.width).toBe(280);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("280");
  });

  it("ignores unrelated keys", () => {
    const { result } = renderHook(() => useResizablePane());
    act(() => result.current.handleKeyDown(arrowKey("ArrowLeft")));
    const widthAfterLeft = result.current.width;
    act(() => result.current.handleKeyDown({ key: "Enter", preventDefault: () => {} } as unknown as ReactKeyboardEvent));
    expect(result.current.width).toBe(widthAfterLeft);
  });

  it("adjusts width on mouse drag and persists on mouseup", () => {
    const { result } = renderHook(() => useResizablePane());
    act(() => {
      result.current.startDrag({
        preventDefault: () => {},
        clientX: 100,
      } as unknown as ReactMouseEvent);
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 150 }));
    });
    expect(result.current.width).toBe(440);
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBe("440");
  });
});
