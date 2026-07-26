import {
  Component,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { isNodeSelection } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { useTranslation } from "react-i18next";
import { sanitizeEmailHtml } from "../reader/sanitize";
import { MarkerBlock } from "./markerBlockExtension";
import {
  IMAGE_SIZE_PRESETS,
  ResizableImage,
  type ImageAlign,
  type ImageSizePreset,
} from "./resizableImageExtension";

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
        className="min-h-[220px] px-0.5 py-3.5 text-[14.5px] leading-[1.6] field-focus-line"
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
//
// ResizableImage (./resizableImageExtension) extends the base Image node
// with `width`/`align` attributes rendered as inline style, so a picked
// size/alignment survives getHTML()/setContent() round-trips exactly like
// src/alt/title already did.
const configuredImage = ResizableImage.configure({ allowBase64: true });

// Paragraphs only (headings aren't offered via any toolbar control here, but
// StarterKit's schema includes the heading node — e.g. pasted content — so
// this keeps text-align consistent if one shows up).
const configuredTextAlign = TextAlign.configure({ types: ["heading", "paragraph"] });

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

  // Bumped on every transaction (content OR selection-only) so the toolbar
  // re-renders when e.g. the user clicks an image (a pure NodeSelection
  // change, no document change) — onUpdate alone only fires when the doc
  // changes, which would leave "is an image selected" / aria-pressed stale.
  const [, forceToolbarUpdate] = useReducer((count: number) => count + 1, 0);

  const editor = useEditor({
    extensions: [StarterKit, configuredLink, configuredImage, configuredTextAlign, MarkerBlock],
    content: html,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": ariaLabel,
        "aria-multiline": "true",
        class: "field-focus-line",
      },
    },
    onUpdate: ({ editor: current }) => {
      onChange(current.getHTML());
      setIsEmpty(current.isEmpty);
    },
    onTransaction: () => {
      forceToolbarUpdate();
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

  const isImageSelected = editor.isActive("image");
  const selectedImageAttrs = isImageSelected
    ? (editor.getAttributes("image") as { width?: string | null; align?: ImageAlign | null })
    : null;

  function setImageSize(preset: ImageSizePreset) {
    editor?.chain().focus().updateAttributes("image", { width: IMAGE_SIZE_PRESETS[preset] }).run();
  }

  function setImageAlign(align: ImageAlign) {
    editor?.chain().focus().updateAttributes("image", { align }).run();
  }

  function setParagraphAlign(align: "left" | "center" | "right") {
    editor?.chain().focus().setTextAlign(align).run();
  }

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

      // If the current selection is still a NodeSelection sitting on an
      // image — most likely left there by this very handler on a previous
      // insertion (see setNodeSelection below) — setImage()'s underlying
      // insertContent command targets {from: tr.selection.from, to:
      // tr.selection.to}, which for a NodeSelection spans exactly that
      // node. Left as-is, inserting a second image would REPLACE the first
      // one instead of adding a new one alongside it (verified directly
      // against @tiptap/core 2.27.2: calling setImage() while a
      // NodeSelection covers a prior image collapses the document back
      // down to a single image). Insert directly at the position right
      // after that image instead, so consecutive insertions accumulate —
      // exactly like before this fix, when the selection was left as a
      // cursor after the node rather than a NodeSelection on it. (An
      // earlier version of this fix first collapsed the selection with
      // setTextSelection(selection.to) and then called plain setImage(),
      // but that position sits at a boundary between two block nodes —
      // not inside any textblock's inline content — which is a degenerate
      // TextSelection ProseMirror only warns about, so insertContentAt
      // targets that position directly instead of round-tripping through a
      // TextSelection at all.) Every other case (a plain text cursor, or a
      // NodeSelection on something other than an image) is untouched and
      // keeps going through setImage()'s normal current-selection-based
      // insertion, exactly as before this fix.
      const { selection } = editor.state;
      if (isNodeSelection(selection) && selection.node.type.name === "image") {
        editor
          .chain()
          .focus()
          .insertContentAt(selection.to, { type: "image", attrs: { src: dataUrl } })
          .run();
      } else {
        editor.chain().focus().setImage({ src: dataUrl }).run();
      }

      // Immediately select the freshly-inserted image as a NodeSelection so
      // the size/align controls below (gated on isImageSelected) are usable
      // right away — otherwise the obvious "insert an image, then resize
      // it" workflow leaves them disabled until the user separately clicks
      // the image (issue #127).
      //
      // Multiple nodes can share the same `src` — the document may already
      // contain an identical image, or the user can insert the same file
      // twice — so matching on src alone is ambiguous. `setImage` above
      // inserts at, and moves the cursor to just after, the current
      // selection, which places the new node at or after any pre-existing
      // occurrence of the same image. Walking the document forward and
      // keeping the LAST matching position (rather than stopping at the
      // first, like resizableImageExtension.test.ts's `imagePos` helper
      // does for "the" image) therefore lands on the node that was just
      // inserted, not an earlier duplicate.
      let insertedPos = -1;
      editor.state.doc.descendants((node, nodePos) => {
        if (node.type.name === "image" && node.attrs.src === dataUrl) {
          insertedPos = nodePos;
        }
      });
      if (insertedPos !== -1) {
        editor.commands.setNodeSelection(insertedPos);
      }

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
        <div role="group" className="flex items-center gap-1 border-l border-line pl-1.5 ml-0.5">
          <button
            type="button"
            aria-label={t("composer.textAlignLeft")}
            aria-pressed={editor.isActive({ textAlign: "left" })}
            onClick={() => setParagraphAlign("left")}
            className="rounded px-2 py-1 text-sm hover:bg-hover aria-pressed:bg-sel"
          >
            L
          </button>
          <button
            type="button"
            aria-label={t("composer.textAlignCenter")}
            aria-pressed={editor.isActive({ textAlign: "center" })}
            onClick={() => setParagraphAlign("center")}
            className="rounded px-2 py-1 text-sm hover:bg-hover aria-pressed:bg-sel"
          >
            C
          </button>
          <button
            type="button"
            aria-label={t("composer.textAlignRight")}
            aria-pressed={editor.isActive({ textAlign: "right" })}
            onClick={() => setParagraphAlign("right")}
            className="rounded px-2 py-1 text-sm hover:bg-hover aria-pressed:bg-sel"
          >
            R
          </button>
        </div>
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
            className="ml-1 rounded-input border border-line bg-panel px-1 py-0.5 text-xs text-ink field-focus"
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
        {/* Only act on the currently selected image (disabled otherwise) —
            these apply updateAttributes('image', ...) to whatever image node
            holds the selection, so they must not silently no-op or affect an
            unintended image when nothing is selected. */}
        <div role="group" className="flex items-center gap-1 border-l border-line pl-1.5 ml-0.5">
          <button
            type="button"
            aria-label={t("composer.imageSizeSmall")}
            aria-pressed={selectedImageAttrs?.width === IMAGE_SIZE_PRESETS.small}
            disabled={!isImageSelected}
            onClick={() => setImageSize("small")}
            className="rounded px-2 py-1 text-sm hover:bg-hover aria-pressed:bg-sel disabled:pointer-events-none disabled:opacity-40"
          >
            S
          </button>
          <button
            type="button"
            aria-label={t("composer.imageSizeMedium")}
            aria-pressed={selectedImageAttrs?.width === IMAGE_SIZE_PRESETS.medium}
            disabled={!isImageSelected}
            onClick={() => setImageSize("medium")}
            className="rounded px-2 py-1 text-sm hover:bg-hover aria-pressed:bg-sel disabled:pointer-events-none disabled:opacity-40"
          >
            M
          </button>
          <button
            type="button"
            aria-label={t("composer.imageSizeLarge")}
            aria-pressed={selectedImageAttrs?.width === IMAGE_SIZE_PRESETS.large}
            disabled={!isImageSelected}
            onClick={() => setImageSize("large")}
            className="rounded px-2 py-1 text-sm hover:bg-hover aria-pressed:bg-sel disabled:pointer-events-none disabled:opacity-40"
          >
            L
          </button>
        </div>
        <div role="group" className="flex items-center gap-1 border-l border-line pl-1.5 ml-0.5">
          <button
            type="button"
            aria-label={t("composer.imageAlignLeft")}
            aria-pressed={selectedImageAttrs?.align === "left"}
            disabled={!isImageSelected}
            onClick={() => setImageAlign("left")}
            className="rounded px-2 py-1 text-sm hover:bg-hover aria-pressed:bg-sel disabled:pointer-events-none disabled:opacity-40"
          >
            L
          </button>
          <button
            type="button"
            aria-label={t("composer.imageAlignCenter")}
            aria-pressed={selectedImageAttrs?.align === "center"}
            disabled={!isImageSelected}
            onClick={() => setImageAlign("center")}
            className="rounded px-2 py-1 text-sm hover:bg-hover aria-pressed:bg-sel disabled:pointer-events-none disabled:opacity-40"
          >
            C
          </button>
          <button
            type="button"
            aria-label={t("composer.imageAlignRight")}
            aria-pressed={selectedImageAttrs?.align === "right"}
            disabled={!isImageSelected}
            onClick={() => setImageAlign("right")}
            className="rounded px-2 py-1 text-sm hover:bg-hover aria-pressed:bg-sel disabled:pointer-events-none disabled:opacity-40"
          >
            R
          </button>
        </div>
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
