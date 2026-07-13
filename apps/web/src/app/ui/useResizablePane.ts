import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

export const PANE_MIN_WIDTH = 280;
export const PANE_MAX_WIDTH = 560;
const DEFAULT_WIDTH = 390;
const STORAGE_KEY = "cefiro-list-width";

function clamp(value: number): number {
  return Math.min(PANE_MAX_WIDTH, Math.max(PANE_MIN_WIDTH, value));
}

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= PANE_MIN_WIDTH && stored <= PANE_MAX_WIDTH) {
      return stored;
    }
  } catch {
    // storage unavailable — use the default
  }
  return DEFAULT_WIDTH;
}

function persist(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // storage unavailable — width just won't persist
  }
}

export function useResizablePane() {
  const [width, setWidth] = useState(readWidth);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const detachDrag = useRef<(() => void) | null>(null);

  // safety net: tear down window listeners if the component unmounts mid-drag
  useEffect(() => () => detachDrag.current?.(), []);

  const startDrag = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    dragState.current = { startX: event.clientX, startWidth: width };

    function handleMove(move: MouseEvent) {
      if (!dragState.current) return;
      setWidth(clamp(dragState.current.startWidth + move.clientX - dragState.current.startX));
    }
    function detach() {
      dragState.current = null;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      detachDrag.current = null;
    }
    function handleUp() {
      detach();
      setWidth((current) => {
        persist(current);
        return current;
      });
    }
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    detachDrag.current = detach;
  }, [width]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setWidth((current) => {
      const next = clamp(current + (event.key === "ArrowRight" ? 16 : -16));
      persist(next);
      return next;
    });
  }, []);

  return { width, startDrag, handleKeyDown };
}
