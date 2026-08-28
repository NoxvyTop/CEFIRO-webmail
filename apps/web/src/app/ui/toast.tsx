import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

type ToastVariant = "status" | "error";

interface ShowToastOptions {
  /**
   * "status" (default): a brief, auto-dismissing confirmation — role="status"
   * (polite), the original 2.6s window, no dismiss control. "error": #348 —
   * role="alert" (assertive, since a failure needs to interrupt), a longer
   * window so there's time to actually read it, pausable on hover/focus so
   * it never vanishes mid-read, and an explicit dismiss button.
   */
  variant?: ToastVariant;
}

type ToastContextValue = { showToast: (message: string, options?: ShowToastOptions) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION_MS = 2600;
// #348: error copy tends to run longer than a confirmation ("archivado") and
// carries more consequence — worth more time on screen before it auto-closes.
const ERROR_TOAST_DURATION_MS = 8000;

interface ToastState {
  message: string;
  variant: ToastVariant;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The moment the current timer is due to fire, and how much time was left
  // on it when it got paused — together these let resume() pick back up
  // instead of restarting the full window (see pause/resume below, #348).
  const dismissAtRef = useRef<number>(0);
  const remainingMsRef = useRef<number>(0);

  function clearTimer() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  const dismiss = useCallback(() => {
    clearTimer();
    setToast(null);
  }, []);

  function scheduleDismiss(durationMs: number) {
    clearTimer();
    dismissAtRef.current = Date.now() + durationMs;
    timer.current = setTimeout(() => setToast(null), durationMs);
  }

  const showToast = useCallback((message: string, options?: ShowToastOptions) => {
    const variant = options?.variant ?? "status";
    setToast({ message, variant });
    scheduleDismiss(variant === "error" ? ERROR_TOAST_DURATION_MS : TOAST_DURATION_MS);
  }, []);

  // #348: hovering/focusing an error toast pauses its auto-dismiss — reading
  // a longer error message shouldn't be a race against the clock. Scoped to
  // the error variant: a brief status confirmation is meant to just go away.
  function pause() {
    if (toast?.variant !== "error" || !timer.current) return;
    remainingMsRef.current = Math.max(0, dismissAtRef.current - Date.now());
    clearTimer();
  }

  function resume() {
    if (toast?.variant !== "error" || remainingMsRef.current <= 0) return;
    scheduleDismiss(remainingMsRef.current);
    remainingMsRef.current = 0;
  }

  useEffect(() => () => clearTimer(), []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        <div
          role={toast.variant === "error" ? "alert" : "status"}
          onMouseEnter={pause}
          onMouseLeave={resume}
          onFocus={pause}
          onBlur={resume}
          className="fixed bottom-[26px] left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-full bg-ink px-5 py-[11px] text-[13.5px] font-medium text-canvas shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
          style={{ animation: "fadeUp 0.22s ease-out" }}
        >
          <span>{toast.message}</span>
          {toast.variant === "error" && (
            <button
              type="button"
              onClick={dismiss}
              aria-label={t("app.toastDismiss")}
              className="-mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-canvas/80 transition hover:bg-white/15 hover:text-canvas"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path
                  d="M1.5 1.5l9 9M10.5 1.5l-9 9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}
