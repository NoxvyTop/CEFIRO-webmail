import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchPushStatus } from "./pushApi";
import { disablePush, enablePush, getExistingPushSubscription, isPushSupported } from "./push";

// #294 (delivery slice): the settings opt-in for Web Push. The whole panel is
// gated on GET /api/push/status being enabled — hidden otherwise — mirroring how
// the composer hides the "draft with AI" CTA on /ai/status. Permission is
// requested only on an explicit click, never on load.

export const PUSH_STATUS_QUERY_KEY = ["push", "status"] as const;

export function PushSettings() {
  const { t } = useTranslation();
  const statusQuery = useQuery({ queryKey: PUSH_STATUS_QUERY_KEY, queryFn: fetchPushStatus });

  // null while the current device state is still being checked; true/false once
  // the browser has told us whether this device already has a subscription.
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const enabled = statusQuery.data === true;
  const supported = isPushSupported();

  useEffect(() => {
    if (!enabled || !supported) return;
    let active = true;
    getExistingPushSubscription()
      .then((sub) => {
        if (active) setSubscribed(sub != null);
      })
      .catch(() => {
        if (active) setSubscribed(false);
      });
    return () => {
      active = false;
    };
  }, [enabled, supported]);

  // Hidden entirely when push is off on the server (or the status has not
  // resolved yet) — the opt-in is never even offered.
  if (!enabled) return null;

  if (!supported) {
    return <p className="text-sm text-muted">{t("notifications.unsupported")}</p>;
  }

  async function handleEnable() {
    setBusy(true);
    setErrorKey(null);
    try {
      const outcome = await enablePush();
      if (outcome === "subscribed") {
        setSubscribed(true);
      } else if (outcome === "denied") {
        setErrorKey("notifications.errors.permissionDenied");
      } else {
        // "unavailable" (server has no key) or "unsupported" (lost the APIs).
        setErrorKey("notifications.errors.unavailable");
      }
    } catch {
      setErrorKey("notifications.errors.generic");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    setErrorKey(null);
    try {
      await disablePush();
      setSubscribed(false);
    } catch {
      setErrorKey("notifications.errors.generic");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t("notifications.description")}</p>

      {errorKey && (
        <p role="alert" className="text-sm text-danger">
          {t(errorKey)}
        </p>
      )}

      {subscribed === null ? (
        <p className="text-sm text-muted">{t("notifications.working")}</p>
      ) : subscribed ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink">{t("notifications.enabledOnThisDevice")}</p>
          <button
            type="button"
            onClick={() => void handleDisable()}
            disabled={busy}
            className="self-start rounded-[11px] border border-line px-3 py-1 text-sm font-semibold text-ink transition hover:bg-hover disabled:opacity-60"
          >
            {busy ? t("notifications.working") : t("notifications.disable")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void handleEnable()}
          disabled={busy}
          className="self-start rounded-[11px] bg-accent px-3 py-1 text-sm font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98] disabled:opacity-60"
        >
          {busy ? t("notifications.working") : t("notifications.enable")}
        </button>
      )}
    </div>
  );
}
