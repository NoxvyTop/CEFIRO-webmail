import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { useTranslation } from "react-i18next";
import { sanitizeEmailHtml } from "../reader/sanitize";
import { MarkerBlock } from "./markerBlockExtension";

export interface RichTextEditorProps {
  html: string;
  onChange(html: string): void;
  ariaLabel: string;
}

// Protocols allowed for links inserted or auto-linked in the composer. Anything else
// (javascript:, data:, vbscript:, file:, etc.) is a stored-XSS vector once the composed
// HTML is rendered elsewhere (reply quotes, recipient's mail client).
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

// Matches DOMPurify's / TipTap's own whitespace-stripping defense: control characters and
// unicode whitespace can be interleaved into a scheme to dodge naive prefix checks, e.g.
// "java\tscript:alert(1)" or "\tjavascript:alert(1)". Stripping them first before extracting
// the scheme neutralizes that obfuscation instead of being fooled by it.
const CONTROL_AND_WHITESPACE_PATTERN = new RegExp('[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]', 'g');

/**
 * Returns true only for absolute http:, https:, or mailto: URLs. Relative URLs, unknown
 * schemes, and obfuscated dangerous schemes (leading whitespace/control chars, embedded
 * control chars splitting the scheme name) are rejected.
 */
export function isSafeLinkUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const stripped = url.replace(CONTROL_AND_WHITESPACE_PATTERN, "");
  const match = stripped.match(/^([a-z][a-z0-9+.-]*):/i);
  const schemeName = match?.[1];
  if (!schemeName) return false;
  const scheme = `${schemeName.toLowerCase()}:`;
  return SAFE_LINK_PROTOCOLS.has(scheme);
}

// Treats a doc with only whitespace/empty tags (e.g. "", "<p></p>", "<p><br></p>")
// as empty, so the placeholder shows until the user actually types content.
function isHtmlEmpty(html: string): boolean {
  return html.replace(/<[^>]*>/g, "").trim().length === 0;
}

interface ErrorBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class EditorErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function ContentEditableFallback({ html, onChange, ariaLabel }: RichTextEditorProps) {
  const { t } = useTranslation();
  // Sanitize initial HTML seed only once to prevent rendering remote/active content.
  // Do not re-sanitize on every render to avoid resetting contentEditable cursor position.
  const safeHtml = useMemo(
    () => sanitizeEmailHtml(html, { allowRemoteImages: false }).html,
    [], // Empty dependency array: capture initial html value only
  );
  // Tracked locally (not derived from the `html` prop on every render) so the
  // placeholder reacts to live typing even when the caller doesn't round-trip
  // onChange back into a new `html` prop on every keystroke.
  const [isEmpty, setIsEmpty] = useState(() => isHtmlEmpty(html));

  function handleInput(event: FormEvent<HTMLDivElement>) {
    const nextHtml = event.currentTarget.innerHTML;
    onChange(nextHtml);
    setIsEmpty(isHtmlEmpty(nextHtml));
  }

  return (
    <div className="relative">
      {isEmpty && (
        <p className="pointer-events-none absolute left-0.5 top-3.5 text-[14.5px] leading-[1.6] text-muted">
          {t("composer.bodyPlaceholder")}
        </p>
      )}
      <div
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        className="min-h-[220px] px-0.5 py-3.5 text-[14.5px] leading-[1.6]"
        // eslint-disable-next-line react/no-danger -- initial content only; sanitized seed + ongoing edits through onInput
        dangerouslySetInnerHTML={{ __html: safeHtml }}
        onInput={handleInput}
      />
    </div>
  );
}

// Shared Link extension config: restricts inserted, pasted, and auto-linked URLs to the
// http/https/mailto allowlist via isAllowedUri (covers setLink + paste) and shouldAutoLink
// (covers as-you-type autolinking). Note: the extension's built-in `protocols` option only
// ADDS to a broad default allowlist (ftp, tel, cid, xmpp, ...) rather than replacing it, so
// isSafeLinkUrl is the actual enforcement here; `protocols` is kept for documentation/parity.
const configuredLink = Link.configure({
  protocols: ["http", "https", "mailto"],
  isAllowedUri: (url) => isSafeLinkUrl(url),
  shouldAutoLink: (url) => isSafeLinkUrl(url),
});

// Images inserted from disk are embedded as data: URLs directly in the
// signature/body HTML (see handleImageFileSelected below) — self-contained,
// so they survive storage and render in the sandboxed reader iframe without
// needing auth or a same-origin fetch (the same reasoning that resolved
// inline cid: images to data: URLs for EmailBody). Only raster formats that
// can't carry executable content are allowed; SVG is deliberately excluded
// since it can embed <script>.
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// ~1 MiB cap: generous for a signature logo or small inline image, but small
// enough to avoid bloating draft/signature rows in the DB with base64 blobs
// (base64 itself already inflates the raw bytes by ~33%).
const MAX_IMAGE_BYTES = 1024 * 1024;

// allowBase64 defaults to false in @tiptap/extension-image, which sets its
// parseHTML rule to `img[src]:not([src^="data:"])` — i.e. it silently drops
// any data: image on parse. setImage() (used below) bypasses that on the
// initial insert since it builds the node directly via insertContent, but
// every subsequent `editor.commands.setContent(html, false)` call (the
// useEffect below, which fires whenever the `html` prop is re-synced from
// outside — e.g. applySignature() rewrapping bodyHtml on a signature switch,
// or the initial mount of a draft/reply whose bodyHtml already has an
// inline image) re-parses the whole document through the schema and would
// strip the image without this.
const configuredImage = Image.configure({ allowBase64: true });

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

function TipTapEditor({ html, onChange, ariaLabel }: RichTextEditorProps) {
  const { t } = useTranslation();
  const [linkInputOpen, setLinkInputOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkInvalid, setLinkInvalid] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  // Tracked via TipTap's own editor.isEmpty on every update (not derived from
  // the `html` prop) so the placeholder reacts to live typing immediately,
  // instead of waiting for the caller to round-trip onChange into a new prop.
  const [isEmpty, setIsEmpty] = useState(() => isHtmlEmpty(html));

  const editor = useEditor({
    extensions: [StarterKit, configuredLink, configuredImage, MarkerBlock],
    content: html,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": ariaLabel,
        "aria-multiline": "true",
      },
    },
    onUpdate: ({ editor: current }) => {
      onChange(current.getHTML());
      setIsEmpty(current.isEmpty);
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (html !== editor.getHTML()) {
      editor.commands.setContent(html, false);
      setIsEmpty(isHtmlEmpty(html));
    }
  }, [editor, html]);

  if (!editor) return null;

  function applyLink() {
    if (!editor) return;
    const url = linkUrl.trim();
    if (!url) {
      setLinkUrl("");
      setLinkInputOpen(false);
      setLinkInvalid(false);
      return;
    }
    if (!isSafeLinkUrl(url)) {
      setLinkInvalid(true);
      return;
    }
    editor.chain().focus().setLink({ href: url }).run();
    setLinkUrl("");
    setLinkInputOpen(false);
    setLinkInvalid(false);
  }

  async function handleImageFileSelected(event: ChangeEvent<HTMLInputElement>) {
    if (!editor) return;
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Always allow re-selecting the same file (browsers don't fire onChange
    // again otherwise since the input's value wouldn't have changed).
    input.value = "";
    if (!file) return;

    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      setImageError(t("composer.imageInvalidType"));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError(t("composer.imageTooLarge"));
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      // The component may have unmounted (destroying the TipTap editor)
      // while this read was in flight. `editor` is a stable closure
      // reference — it is never reassigned to null — so re-testing
      // `!editor` here would be a no-op; `isDestroyed` is TipTap's actual
      // signal that this Editor instance is no longer safe to command.
      if (editor.isDestroyed) return;
      editor.chain().focus().setImage({ src: dataUrl }).run();
      setImageError(null);
    } catch {
      setImageError(t("composer.errors.generic"));
    }
  }

  return (
    <div className="flex flex-col">
      <div role="toolbar" className="flex items-center gap-1 border-b border-line pb-1.5">
        <button
          type="button"
          aria-label={t("composer.bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          className="rounded px-2 py-1 text-sm font-bold hover:bg-hover"
        >
          B
        </button>
        <button
          type="button"
          aria-label={t("composer.italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className="rounded px-2 py-1 text-sm italic hover:bg-hover"
        >
          I
        </button>
        <button
          type="button"
          aria-label={t("composer.bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className="rounded px-2 py-1 text-sm hover:bg-hover"
        >
          •
        </button>
        <button
          type="button"
          aria-label={t("composer.link")}
          onClick={() => setLinkInputOpen((open) => !open)}
          className="rounded px-2 py-1 text-sm underline hover:bg-hover"
        >
          {t("composer.link")}
        </button>
        {linkInputOpen && (
          <input
            aria-label={t("composer.linkUrl")}
            value={linkUrl}
            onChange={(event) => {
              setLinkUrl(event.target.value);
              setLinkInvalid(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyLink();
              }
            }}
            className="ml-1 rounded-input border border-line bg-panel px-1 py-0.5 text-xs text-ink outline-none focus:border-accent"
          />
        )}
        {linkInvalid && <p className="text-xs text-warn">{t("composer.invalidLink")}</p>}
        <input
          ref={imageInputRef}
          type="file"
          accept={Array.from(ALLOWED_IMAGE_TYPES).join(",")}
          aria-label={t("composer.image")}
          onChange={handleImageFileSelected}
          className="sr-only"
        />
        <button
          type="button"
          aria-label={t("composer.insertImage")}
          onClick={() => imageInputRef.current?.click()}
          className="rounded px-2 py-1 text-sm hover:bg-hover"
        >
          {t("composer.insertImage")}
        </button>
        {imageError && <p className="text-xs text-warn">{imageError}</p>}
      </div>
      <div className="relative">
        {isEmpty && (
          <p className="pointer-events-none absolute left-0.5 top-3.5 text-[14.5px] leading-[1.6] text-muted">
            {t("composer.bodyPlaceholder")}
          </p>
        )}
        <EditorContent editor={editor} className="min-h-[220px] px-0.5 py-3.5 text-[14.5px] leading-[1.6]" />
      </div>
    </div>
  );
}

export function RichTextEditor(props: RichTextEditorProps) {
  return (
    <EditorErrorBoundary fallback={<ContentEditableFallback {...props} />}>
      <TipTapEditor {...props} />
    </EditorErrorBoundary>
  );
}
