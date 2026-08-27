import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { IMAGE_SIZE_PRESETS, ResizableImage } from "./resizableImageExtension";

function editorWithImage(attrs: Record<string, unknown> = {}): Editor {
  const editor = new Editor({
    extensions: [StarterKit, ResizableImage],
    content: "<p></p>",
  });
  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: "image",
    attrs: { src: "data:image/png;base64,AAAA", ...attrs },
  });
  return editor;
}

// Locates the (single) image node's document position, mirroring how the
// toolbar would target the currently-selected image via setNodeSelection.
function imagePos(editor: Editor): number {
  let pos = -1;
  editor.state.doc.descendants((node, nodePos) => {
    if (node.type.name === "image") pos = nodePos;
  });
  if (pos === -1) throw new Error("image node not found in doc");
  return pos;
}

describe("ResizableImage extension", () => {
  it("renders a width style when the width attribute is set", () => {
    const editor = editorWithImage({ width: IMAGE_SIZE_PRESETS.medium });
    try {
      expect(editor.getHTML()).toContain(`width: ${IMAGE_SIZE_PRESETS.medium}`);
    } finally {
      editor.destroy();
    }
  });

  it("renders center alignment as block-level auto margins", () => {
    const editor = editorWithImage({ align: "center" });
    try {
      const html = editor.getHTML();
      expect(html).toContain("display: block");
      expect(html).toContain("margin-left: auto");
      expect(html).toContain("margin-right: auto");
    } finally {
      editor.destroy();
    }
  });

  it("renders left and right alignment distinctly", () => {
    const left = editorWithImage({ align: "left" });
    const right = editorWithImage({ align: "right" });
    try {
      expect(left.getHTML()).toContain("margin-right: auto");
      expect(right.getHTML()).toContain("margin-left: auto");
    } finally {
      left.destroy();
      right.destroy();
    }
  });

  it("combines width and align into a single merged style attribute", () => {
    const editor = editorWithImage({ width: IMAGE_SIZE_PRESETS.small, align: "right" });
    try {
      const html = editor.getHTML();
      const style = /<img[^>]*style="([^"]*)"/.exec(html)?.[1] ?? "";
      expect(style).toContain(`width: ${IMAGE_SIZE_PRESETS.small}`);
      expect(style).toContain("margin-left: auto");
      // Exactly one style attribute on the img, not two competing ones.
      expect(html.match(/style="/g)).toHaveLength(1);
    } finally {
      editor.destroy();
    }
  });

  it("omits the style attribute entirely when neither width nor align is set", () => {
    const editor = editorWithImage();
    try {
      expect(editor.getHTML()).not.toContain("style=");
    } finally {
      editor.destroy();
    }
  });

  it("parses width and align back out of an inline style on load", () => {
    const html =
      '<img src="data:image/png;base64,AAAA" style="width: 25%; display: block; margin-left: 0; margin-right: auto;" />';
    // allowBase64 defaults to false on @tiptap/extension-image, which rejects
    // `img[src^="data:"]` entirely on parse — same reasoning documented next
    // to `configuredImage` in RichTextEditor.tsx. Must configure it here too,
    // or the whole <img> (not just width/align) is dropped on parse.
    const editor = new Editor({
      extensions: [StarterKit, ResizableImage.configure({ allowBase64: true })],
      content: html,
    });
    try {
      let attrs: Record<string, unknown> | null = null;
      editor.state.doc.descendants((node) => {
        if (node.type.name === "image") attrs = node.attrs;
      });
      expect(attrs).toMatchObject({ width: "25%", align: "left" });
    } finally {
      editor.destroy();
    }
  });

  it("updates width via updateAttributes on a selected image node (the command the toolbar issues)", () => {
    const editor = editorWithImage();
    try {
      editor.commands.setNodeSelection(imagePos(editor));
      editor.chain().focus().updateAttributes("image", { width: IMAGE_SIZE_PRESETS.large }).run();
      expect(editor.getHTML()).toContain(`width: ${IMAGE_SIZE_PRESETS.large}`);
    } finally {
      editor.destroy();
    }
  });

  it("updates align via updateAttributes on a selected image node", () => {
    const editor = editorWithImage();
    try {
      editor.commands.setNodeSelection(imagePos(editor));
      editor.chain().focus().updateAttributes("image", { align: "center" }).run();
      const html = editor.getHTML();
      expect(html).toContain("margin-left: auto");
      expect(html).toContain("margin-right: auto");
    } finally {
      editor.destroy();
    }
  });

  it("does not affect an unselected image when a different node is targeted", () => {
    const editor = editorWithImage();
    try {
      // Select the start of the doc (the empty paragraph), not the image.
      editor.commands.setTextSelection(0);
      editor.chain().focus().updateAttributes("image", { width: IMAGE_SIZE_PRESETS.large }).run();
      expect(editor.getHTML()).not.toContain("style=");
    } finally {
      editor.destroy();
    }
  });

  // The toolbar itself only ever passes IMAGE_SIZE_PRESETS values, so these
  // paths aren't reachable from the UI today. But `width`'s renderHTML used
  // to interpolate attributes.width verbatim into the style string — unlike
  // `align`, which was already gated by an isImageAlign allowlist — so any
  // other caller of updateAttributes('image', { width }) or a JSON content
  // insert (both bypass the CSSOM-parsing parseHTML guard entirely) could
  // smuggle arbitrary CSS, including a second `url(...)` declaration, into
  // the live editor DOM via a plain string concatenation. These lock the
  // fix: width is now validated against the same fixed-preset allowlist
  // pattern as align, on both the write (renderHTML) and read (parseHTML)
  // side, so no raw attribute value ever flows into the style attribute.
  describe("width allowlist (defense in depth against a crafted width attribute)", () => {
    it("drops a crafted width value smuggling a background:url() declaration — no style is emitted", () => {
      const editor = editorWithImage({ width: "50%;background:url(http://evil.com/x)" });
      try {
        const html = editor.getHTML();
        expect(html).not.toContain("style=");
        expect(html).not.toContain("url(");
        expect(html).not.toContain("evil.com");
      } finally {
        editor.destroy();
      }
    });

    it("drops a crafted width value containing an expression() payload", () => {
      const editor = editorWithImage({ width: "expression(alert(1))" });
      try {
        const html = editor.getHTML();
        expect(html).not.toContain("style=");
        expect(html).not.toContain("expression(");
      } finally {
        editor.destroy();
      }
    });

    it("still renders a legitimate preset width alongside a rejected align, independently", () => {
      // Confirms the allowlist rejects only the bad attribute, not the whole
      // style pipeline for the node.
      const editor = editorWithImage({ width: IMAGE_SIZE_PRESETS.large, align: "not-a-real-align" });
      try {
        const html = editor.getHTML();
        expect(html).toContain(`width: ${IMAGE_SIZE_PRESETS.large}`);
        expect(html).not.toContain("not-a-real-align");
      } finally {
        editor.destroy();
      }
    });

    it("rejects a non-preset width on parse from raw HTML (parseHTML side), keeping the attribute null", () => {
      const html =
        '<img src="data:image/png;base64,AAAA" style="width: 33%; background: url(http://evil.com/x);" />';
      const editor = new Editor({
        extensions: [StarterKit, ResizableImage.configure({ allowBase64: true })],
        content: html,
      });
      try {
        let attrs: Record<string, unknown> | null = null;
        editor.state.doc.descendants((node) => {
          if (node.type.name === "image") attrs = node.attrs;
        });
        expect(attrs).toMatchObject({ width: null });
        expect(editor.getHTML()).not.toContain("style=");
      } finally {
        editor.destroy();
      }
    });
  });
});
