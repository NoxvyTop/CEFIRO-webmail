import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useResizablePane } from "./useResizablePane";

const STORAGE_KEY = "cefiro-list-width";
const ORIGINAL_INNER_WIDTH = window.innerWidth;

function arrowKey(key: "ArrowLeft" | "ArrowRight") {
  return {
    key,
    preventDefault: () => {},
  } as unknown as ReactKeyboardEvent;
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  setViewportWidth(ORIGINAL_INNER_WIDTH);
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

  it("clamps a stored width above the current maximum instead of discarding it", () => {
    localStorage.setItem(STORAGE_KEY, "999");
    const { result } = renderHook(() => useResizablePane());
    expect(result.current.width).toBe(560);
  });

  it("clamps a stored width below the minimum instead of discarding it", () => {
    localStorage.setItem(STORAGE_KEY, "100");
    const { result } = renderHook(() => useResizablePane());
    expect(result.current.width).toBe(280);
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

  it("derives a maximum above 560 on a wide viewport and allows dragging past it", () => {
    setViewportWidth(1600); // half the viewport is 800
    const { result } = renderHook(() => useResizablePane());
    expect(result.current.maxWidth).toBe(800);
    act(() => {
      result.current.startDrag({ preventDefault: () => {}, clientX: 0 } as unknown as ReactMouseEvent);
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 300 }));
    });
    expect(result.current.width).toBe(690);
    expect(result.current.width).toBeGreaterThan(560);
  });

  it("floors the maximum at 560 on a narrow viewport (today's behavior preserved)", () => {
    setViewportWidth(700); // half the viewport is 350, floored to 560
    const { result } = renderHook(() => useResizablePane());
    expect(result.current.maxWidth).toBe(560);
    act(() => {
      result.current.startDrag({ preventDefault: () => {}, clientX: 0 } as unknown as ReactMouseEvent);
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 1000 }));
    });
    expect(result.current.width).toBe(560);
  });

  it("clamps the current width when the window shrinks below it", () => {
    setViewportWidth(1600); // max 800
    localStorage.setItem(STORAGE_KEY, "700");
    const { result } = renderHook(() => useResizablePane());
    expect(result.current.width).toBe(700);
    act(() => {
      setViewportWidth(900); // new max is 560
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.maxWidth).toBe(560);
    expect(result.current.width).toBe(560);
  });

  it("does not persist width changes caused by a resize", () => {
    setViewportWidth(1600);
    localStorage.setItem(STORAGE_KEY, "700");
    const { result } = renderHook(() => useResizablePane());
    expect(localStorage.getItem(STORAGE_KEY)).toBe("700");
    act(() => {
      setViewportWidth(900);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.width).toBe(560);
    // the live width was clamped by the resize, but the user never dragged or
    // pressed a key — their stored preference must survive untouched
    expect(localStorage.getItem(STORAGE_KEY)).toBe("700");
  });

  it("removes the resize listener on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useResizablePane());
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("resize", expect.any(Function));
    removeSpy.mockRestore();
  });
});
