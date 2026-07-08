import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 390;
const STORAGE_KEY = "cefiro-list-width";

function clamp(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));
}

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH) return stored;
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

  const startDrag = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    dragState.current = { startX: event.clientX, startWidth: width };

    function handleMove(move: MouseEvent) {
      if (!dragState.current) return;
      setWidth(clamp(dragState.current.startWidth + move.clientX - dragState.current.startX));
    }
    function handleUp() {
      dragState.current = null;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      setWidth((current) => {
        persist(current);
        return current;
      });
    }
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
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
