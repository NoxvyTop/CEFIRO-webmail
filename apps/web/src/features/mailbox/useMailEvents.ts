import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

const RETRY_DELAY_MS = 15000;

export function useMailEvents(enabled: boolean): void {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return undefined;

    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function handleMessage() {
      queryClient.invalidateQueries({ queryKey: ["mail"] });
      if (
        document.hidden &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        // eslint-disable-next-line no-new
        new Notification(tRef.current("mail.newMailNotification"));
      }
    }

    function handleError() {
      source?.close();
      retryTimer = setTimeout(connect, RETRY_DELAY_MS);
    }

    function connect() {
      if (cancelled) return;
      source = new EventSource("/api/mail/events");
      source.addEventListener("message", handleMessage);
      source.addEventListener("error", handleError);
    }

    connect();

    return () => {
      cancelled = true;
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [enabled, queryClient]);
}
