import { useEffect, useState } from "react";

/**
 * GH #345: `navigator.onLine` plus the `online`/`offline` events it fires on
 * — there was no offline signal anywhere in the UI before this, so a lost
 * connection looked identical to a slow one until every in-flight request
 * had failed on its own.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    function handleOnline() {
      setOnline(true);
    }
    function handleOffline() {
      setOnline(false);
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return online;
}
