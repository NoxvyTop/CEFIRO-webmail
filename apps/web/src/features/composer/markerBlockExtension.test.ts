import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { MarkerBlock } from "./markerBlockExtension";
import { QUOTE_MARKER_ATTR, SIGNATURE_MARKER_ATTR } from "./signature";

function editorWithContent(content: string): Editor {
  return new Editor({
    extensions: [StarterKit, MarkerBlock],
    content,
  });
}

describe("MarkerBlock extension", () => {
  it("round-trips a signature marker div through parse and serialize", () => {
    const html = `<p>Hello</p><div ${SIGNATURE_MARKER_ATTR}="true"><p>Thanks</p></div>`;
    const editor = editorWithContent(html);
    try {
      expect(editor.getHTML()).toContain(`${SIGNATURE_MARKER_ATTR}="true"`);
      expect(editor.getHTML()).toContain("Thanks");
    } finally {
      editor.destroy();
    }
  });

  it("round-trips a quote marker div through parse and serialize", () => {
    const html = `<p>Hi</p><div ${QUOTE_MARKER_ATTR}="true"><blockquote><p>Quoted</p></blockquote></div>`;
    const editor = editorWithContent(html);
    try {
      expect(editor.getHTML()).toContain(`${QUOTE_MARKER_ATTR}="true"`);
      expect(editor.getHTML()).toContain("Quoted");
    } finally {
      editor.destroy();
    }
  });

  it("survives a subsequent content edit (simulated typing), unlike an unrecognized div", () => {
    const html = `<div ${SIGNATURE_MARKER_ATTR}="true"><p>Thanks</p></div>`;
    const editor = editorWithContent(html);
    try {
      // Simulates what happens on every keystroke: TipTap re-serializes the
      // whole doc to HTML via onUpdate after the transaction is applied.
      editor.commands.insertContentAt(0, "<p>my reply text</p>");
      const html2 = editor.getHTML();

      expect(html2).toContain(`${SIGNATURE_MARKER_ATTR}="true"`);
      expect(html2).toContain("Thanks");
      expect(html2).toContain("my reply text");
    } finally {
      editor.destroy();
    }
  });

  it("keeps an empty marker div (no block children) parseable without throwing", () => {
    const html = `<div ${SIGNATURE_MARKER_ATTR}="true"></div>`;
    let editor: Editor | undefined;
    expect(() => {
      editor = editorWithContent(html);
    }).not.toThrow();
    editor?.destroy();
  });
});
