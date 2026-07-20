import { useEffect, useMemo, useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { sanitizeEmailHtml } from "./sanitize";

interface EmailBodyProps {
  bodyHtml: string | null;
  bodyText: string | null;
}

type Theme = "night" | "light";

// Mirrors --ink from theme.css. The iframe is a separate document, so CSS
// custom properties from the app shell don't cascade into it — the resolved
// hex has to be injected directly into the srcdoc.
const THEME_INK: Record<Theme, string> = {
  night: "#eceef4",
  light: "#101318",
};

// Used until (or unless) the content height can be measured — see
// useContentHeight below for why real sandboxed browsers usually can't.
const FALLBACK_HEIGHT = 200;

function readActiveTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "night";
}

/** Tracks data-theme on <html> so the iframe srcdoc can follow theme toggles. */
function useActiveTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(readActiveTheme);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(readActiveTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

function wrapDocument(bodyInnerHtml: string, theme: Theme) {
  const ink = THEME_INK[theme];
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{background:transparent;margin:0;padding:2px;color:${ink};font-family:"Space Grotesk Variable","Space Grotesk",system-ui,sans-serif;font-size:15px;line-height:1.65}</style></head><body>${bodyInnerHtml}</body></html>`;
}

/**
 * Measures the iframe's rendered content height via onLoad. sandbox=""
 * without allow-same-origin gives the srcdoc document an opaque origin, so
 * contentDocument is unreachable from real sandboxed browsers by design —
 * loosening that would weaken the iframe's isolation of untrusted email
 * HTML, so it stays as-is. The measurement is therefore best-effort: it
 * only succeeds where the sandbox doesn't enforce cross-origin isolation,
 * and falls back to FALLBACK_HEIGHT everywhere else.
 */
function useContentHeight(resetKey: string): {
  height: number;
  onLoad: (event: SyntheticEvent<HTMLIFrameElement>) => void;
} {
  const [height, setHeight] = useState(FALLBACK_HEIGHT);

  useEffect(() => {
    setHeight(FALLBACK_HEIGHT);
  }, [resetKey]);

  function onLoad(event: SyntheticEvent<HTMLIFrameElement>) {
    try {
      const measured = event.currentTarget.contentDocument?.documentElement.scrollHeight;
      if (measured) setHeight(measured);
    } catch {
      // Cross-origin access blocked by the sandbox — expected, keep the fallback height.
    }
  }

  return { height, onLoad };
}

export function EmailBody({ bodyHtml, bodyText }: EmailBodyProps) {
  const { t } = useTranslation();
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);
  const theme = useActiveTheme();

  const sanitized = useMemo(() => {
    if (!bodyHtml) return null;
    // Always re-sanitize from the original raw bodyHtml so toggling
    // allowRemoteImages restores the images that were stripped, rather than
    // re-processing already-blocked (data-blocked-src) markup.
    return sanitizeEmailHtml(bodyHtml, { allowRemoteImages });
  }, [bodyHtml, allowRemoteImages]);

  const { height, onLoad } = useContentHeight(sanitized?.html ?? "");

  if (sanitized) {
    return (
      <div>
        {sanitized.hasRemoteImages && !allowRemoteImages && (
          <button
            type="button"
            onClick={() => setAllowRemoteImages(true)}
            className="mb-2 rounded-md border border-warn/40 bg-soft px-2 py-1 text-xs text-warn"
          >
            {t("mail.loadImages")}
          </button>
        )}
        <iframe
          sandbox=""
          srcDoc={wrapDocument(sanitized.html, theme)}
          onLoad={onLoad}
          title={t("mail.emailContent")}
          style={{ height: `${height}px` }}
          className="block w-full"
        />
      </div>
    );
  }

  if (bodyText) {
    return <pre className="whitespace-pre-wrap text-[15px] leading-[1.65]">{bodyText}</pre>;
  }

  return <p className="text-sm text-muted">{t("mail.emptyBody")}</p>;
}
