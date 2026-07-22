import { mergeAttributes, Node } from "@tiptap/core";
import { QUOTE_MARKER_ATTR, SIGNATURE_MARKER_ATTR } from "./signature";

// TipTap/ProseMirror only preserves elements it has a schema node for; any
// other tag (including custom marker divs like the ones composer/signature.ts
// writes/reads) is treated as unknown and dropped on the first
// parse-then-serialize round trip (StarterKit's default schema has no node
// for a generic <div>). That's what made applySignature's find/replace go
// stale the moment the user typed: `data-cefiro-signature` / `data-cefiro-
// quote` survived only until the next onUpdate re-serialized the doc.
//
// This node gives both marker wrappers a real place in the schema so they
// round-trip losslessly through getHTML()/setContent(), no matter how many
// edits happen in between. A single node (distinguished by a `marker`
// attribute) rather than two separate node types, since both wrappers are
// otherwise identical generic block containers — only the attribute differs.
export const MarkerBlock = Node.create({
  name: "cefiroMarkerBlock",
  group: "block",
  // "block*" (not "block+"): an empty signature (contentHtml === "") or a
  // marker div mid-edit must stay parseable without ProseMirror needing to
  // invent placeholder content to satisfy a required child.
  content: "block*",
  defining: true,

  addAttributes() {
    return {
      marker: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          if (element.hasAttribute(SIGNATURE_MARKER_ATTR)) return "signature";
          if (element.hasAttribute(QUOTE_MARKER_ATTR)) return "quote";
          return null;
        },
        renderHTML: (attributes: { marker: string | null }) => {
          if (attributes.marker === "signature") return { [SIGNATURE_MARKER_ATTR]: "true" };
          if (attributes.marker === "quote") return { [QUOTE_MARKER_ATTR]: "true" };
          return {};
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${SIGNATURE_MARKER_ATTR}]` }, { tag: `div[${QUOTE_MARKER_ATTR}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes), 0];
  },
});
