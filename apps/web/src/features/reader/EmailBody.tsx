import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { sanitizeEmailHtml } from "./sanitize";

interface EmailBodyProps {
  bodyHtml: string | null;
  bodyText: string | null;
}

function wrapDocument(bodyInnerHtml: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;margin:8px;color:#111}</style></head><body>${bodyInnerHtml}</body></html>`;
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
          srcDoc={wrapDocument(sanitized.html)}
          title={t("mail.emailContent")}
          className="h-64 w-full rounded-md border border-line bg-white"
        />
      </div>
    );
  }

  if (bodyText) {
    return <pre className="whitespace-pre-wrap text-sm leading-[1.65]">{bodyText}</pre>;
  }

  return <p className="text-sm text-muted">{t("mail.emptyBody")}</p>;
}
