import { useEffect, useMemo, useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { sanitizeEmailHtml } from "./sanitize";

interface EmailBodyProps {
  bodyHtml: string | null;
  bodyText: string | null;
}

// HTML emails are authored assuming a light background (the Gmail/Outlook
// "paper" convention), so the iframe canvas is always painted light —
// regardless of the app's active theme. Matching the app's dark theme here
// would turn styled marketing HTML with hardcoded dark text (e.g.
// color:#333 on an implicit white background) into unreadable dark-on-dark
// text; rendering it as a clean white card is the safe, standard webmail
// behavior for both simple and styled bodies. Fixed constants — never
// derived from email-controlled content or the app theme.
const EMAIL_PAPER_INK = "#101318";
const EMAIL_PAPER_PANEL = "#ffffff";
const EMAIL_PAPER_COLOR_SCHEME = "light";

// Used until (or unless) the content height can be measured — see
// useContentHeight below for why real sandboxed browsers usually can't (in
// practice this fallback is what most real users see). A generous,
// viewport-proportional value replaces the old fixed 200px box, which read
// as a squat frame floating in dead space (OSCURO-04).
const FALLBACK_HEIGHT = "min(60vh, 640px)";

function wrapDocument(bodyInnerHtml: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:${EMAIL_PAPER_COLOR_SCHEME}}html,body{background:${EMAIL_PAPER_PANEL};margin:0}body{padding:2px;color:${EMAIL_PAPER_INK};font-family:"Space Grotesk Variable","Space Grotesk",system-ui,sans-serif;font-size:15px;line-height:1.65}</style></head><body>${bodyInnerHtml}</body></html>`;
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
  height: string;
  onLoad: (event: SyntheticEvent<HTMLIFrameElement>) => void;
} {
  const [height, setHeight] = useState<string>(FALLBACK_HEIGHT);

  useEffect(() => {
    setHeight(FALLBACK_HEIGHT);
  }, [resetKey]);

  function onLoad(event: SyntheticEvent<HTMLIFrameElement>) {
    try {
      const measured = event.currentTarget.contentDocument?.documentElement.scrollHeight;
      if (measured) setHeight(`${measured}px`);
    } catch {
      // Cross-origin access blocked by the sandbox — expected, keep the fallback height.
    }
  }

  return { height, onLoad };
}

export function EmailBody({ bodyHtml, bodyText }: EmailBodyProps) {
  const { t } = useTranslation();
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);

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
        {/* Hairline border + radius so the always-light email "paper" reads
            as an intentional document card rather than a floating white box
            against a dark app panel (most noticeable in night theme). */}
        <div className="overflow-hidden rounded-[10px] border border-line">
          <iframe
            sandbox=""
            srcDoc={wrapDocument(sanitized.html)}
            onLoad={onLoad}
            title={t("mail.emailContent")}
            style={{ height }}
            className="block w-full"
          />
        </div>
      </div>
    );
  }

  if (bodyText) {
    return <pre className="whitespace-pre-wrap text-[15px] leading-[1.65]">{bodyText}</pre>;
  }

  return <p className="text-sm text-muted">{t("mail.emptyBody")}</p>;
}
