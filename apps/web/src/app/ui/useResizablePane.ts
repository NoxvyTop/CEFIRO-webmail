import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

export const PANE_MIN_WIDTH = 280;
// Historical fixed ceiling, kept as a floor: on a narrow viewport the
// dynamic max below never drops under this, so small screens behave exactly
// as they did before the max became viewport-relative.
const PANE_MAX_WIDTH_FLOOR = 560;
const DEFAULT_WIDTH = 390;
const STORAGE_KEY = "cefiro-list-width";

// Roughly half the window, floored at PANE_MAX_WIDTH_FLOOR — a wide monitor
// can grow the pane well past the old fixed ceiling.
function computeMaxWidth(viewportWidth: number): number {
  return Math.max(PANE_MAX_WIDTH_FLOOR, Math.floor(viewportWidth / 2));
}

function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(PANE_MIN_WIDTH, value));
}

function readWidth(max: number): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // A missing key must not fall through to Number(null) === 0 — that would
    // clamp to PANE_MIN_WIDTH instead of using the default. Only a present,
    // non-numeric/missing value is corrupt enough to discard — a value that
    // is merely out of today's range (e.g. saved on a bigger monitor) is
    // clamped into range instead, so the preference survives.
    if (raw !== null) {
      const stored = Number(raw);
      if (Number.isFinite(stored)) {
        return clamp(stored, max);
      }
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
  const [maxWidth, setMaxWidth] = useState(() => computeMaxWidth(window.innerWidth));
  const [width, setWidth] = useState(() => readWidth(computeMaxWidth(window.innerWidth)));
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const detachDrag = useRef<(() => void) | null>(null);

  // safety net: tear down window listeners if the component unmounts mid-drag
  useEffect(() => () => detachDrag.current?.(), []);

  // A narrower window can push a previously valid width past the new
  // maximum. Reflow it live, but do not persist — resizing the window is
  // not the user expressing a width preference.
  useEffect(() => {
    function handleResize() {
      const nextMax = computeMaxWidth(window.innerWidth);
      setMaxWidth(nextMax);
      setWidth((current) => clamp(current, nextMax));
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const startDrag = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    dragState.current = { startX: event.clientX, startWidth: width };

    function handleMove(move: MouseEvent) {
      if (!dragState.current) return;
      setWidth(clamp(dragState.current.startWidth + move.clientX - dragState.current.startX, maxWidth));
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
  }, [width, maxWidth]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setWidth((current) => {
      const next = clamp(current + (event.key === "ArrowRight" ? 16 : -16), maxWidth);
      persist(next);
      return next;
    });
  }, [maxWidth]);

  return { width, maxWidth, startDrag, handleKeyDown };
}
