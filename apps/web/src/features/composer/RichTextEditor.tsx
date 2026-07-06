import { Component, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { useTranslation } from "react-i18next";
import { sanitizeEmailHtml } from "../reader/sanitize";

export interface RichTextEditorProps {
  html: string;
  onChange(html: string): void;
  ariaLabel: string;
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
  // Sanitize initial HTML seed only once to prevent rendering remote/active content.
  // Do not re-sanitize on every render to avoid resetting contentEditable cursor position.
  const safeHtml = useMemo(
    () => sanitizeEmailHtml(html, { allowRemoteImages: false }).html,
    [], // Empty dependency array: capture initial html value only
  );

  function handleInput(event: FormEvent<HTMLDivElement>) {
    onChange(event.currentTarget.innerHTML);
  }

  return (
    <div
      role="textbox"
      aria-label={ariaLabel}
      aria-multiline="true"
      contentEditable
      suppressContentEditableWarning
      className="min-h-32 rounded-md border p-2 text-sm"
      // eslint-disable-next-line react/no-danger -- initial content only; sanitized seed + ongoing edits through onInput
      dangerouslySetInnerHTML={{ __html: safeHtml }}
      onInput={handleInput}
    />
  );
}

function TipTapEditor({ html, onChange, ariaLabel }: RichTextEditorProps) {
  const { t } = useTranslation();
  const [linkInputOpen, setLinkInputOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const editor = useEditor({
    extensions: [StarterKit, Link],
    content: html,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": ariaLabel,
        "aria-multiline": "true",
      },
    },
    onUpdate: ({ editor: current }) => onChange(current.getHTML()),
  });

  useEffect(() => {
    if (!editor) return;
    if (html !== editor.getHTML()) {
      editor.commands.setContent(html, false);
    }
  }, [editor, html]);

  if (!editor) return null;

  function applyLink() {
    if (!editor) return;
    const url = linkUrl.trim();
    if (url) {
      editor.chain().focus().setLink({ href: url }).run();
    }
    setLinkUrl("");
    setLinkInputOpen(false);
  }

  return (
    <div className="rounded-md border">
      <div role="toolbar" className="flex items-center gap-1 border-b p-1">
        <button
          type="button"
          aria-label={t("composer.bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          className="rounded px-2 py-1 text-sm font-bold"
        >
          B
        </button>
        <button
          type="button"
          aria-label={t("composer.italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className="rounded px-2 py-1 text-sm italic"
        >
          I
        </button>
        <button
          type="button"
          aria-label={t("composer.bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className="rounded px-2 py-1 text-sm"
        >
          •
        </button>
        <button
          type="button"
          aria-label={t("composer.link")}
          onClick={() => setLinkInputOpen((open) => !open)}
          className="rounded px-2 py-1 text-sm underline"
        >
          {t("composer.link")}
        </button>
        {linkInputOpen && (
          <input
            aria-label={t("composer.linkUrl")}
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyLink();
              }
            }}
            className="ml-1 rounded border px-1 py-0.5 text-xs"
          />
        )}
      </div>
      <EditorContent editor={editor} className="min-h-32 p-2 text-sm" />
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
