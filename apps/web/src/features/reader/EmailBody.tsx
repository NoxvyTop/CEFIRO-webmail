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
// hex has to be injected directly into the srcdoc. Fixed two-value map keyed
// by theme — never derived from email-controlled content.
const THEME_INK: Record<Theme, string> = {
  night: "#eceef4",
  light: "#101318",
};

// Mirrors --panel from theme.css, same rationale as THEME_INK above.
//
// The srcdoc document has no color-scheme/background of its own, so an
// unstyled canvas paints white by default — that's the OSCURO-01/CLARO-13
// "white box" bug. Relying on `color-scheme` + `background: transparent`
// alone to make the UA paint a themed canvas isn't a safe fix: the resulting
// fallback canvas color is UA-chosen (varies across Chromium/Firefox/Safari
// and versions) and isn't guaranteed to match --panel, and jsdom can't
// verify actual paint either way. Painting the panel color explicitly is
// deterministic, matches the design token exactly in every engine, and is
// verifiable in tests the same way THEME_INK already is.
const THEME_PANEL: Record<Theme, string> = {
  night: "#12141c",
  light: "#ffffff",
};

// Declared regardless of the explicit panel paint above so native form
// controls/scrollbars rendered inside the srcdoc (if any) pick up the
// correct theme instead of defaulting to light.
const THEME_COLOR_SCHEME: Record<Theme, "dark" | "light"> = {
  night: "dark",
  light: "light",
};

// Used until (or unless) the content height can be measured — see
// useContentHeight below for why real sandboxed browsers usually can't (in
// practice this fallback is what most real users see). A generous,
// viewport-proportional value replaces the old fixed 200px box, which read
// as a squat frame floating in dead space (OSCURO-04).
const FALLBACK_HEIGHT = "min(60vh, 640px)";

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
  const panel = THEME_PANEL[theme];
  const colorScheme = THEME_COLOR_SCHEME[theme];
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:${colorScheme}}html,body{background:${panel};margin:0}body{padding:2px;color:${ink};font-family:"Space Grotesk Variable","Space Grotesk",system-ui,sans-serif;font-size:15px;line-height:1.65}</style></head><body>${bodyInnerHtml}</body></html>`;
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
          style={{ height }}
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
