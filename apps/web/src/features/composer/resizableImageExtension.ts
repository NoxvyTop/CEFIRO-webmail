import Image from "@tiptap/extension-image";

// Gmail-like preset widths for an inserted image. Percentages (not fixed px)
// so the image scales with its container in both the editor and the
// eventual reader, instead of overflowing a narrower reading pane.
export const IMAGE_SIZE_PRESETS = {
  small: "25%",
  medium: "50%",
  large: "100%",
} as const;

export type ImageSizePreset = keyof typeof IMAGE_SIZE_PRESETS;
export type ImageAlign = "left" | "center" | "right";

export const IMAGE_ALIGN_VALUES: ImageAlign[] = ["left", "center", "right"];

// `display: block` is required for margin-left/margin-right: auto to have
// any effect on an <img>, which is inline-level by default. These are plain
// box-model declarations (no url(), no expression()), so they pass through
// sanitizeEmailHtml's DOMPurify pass unchanged (the "html" profile keeps the
// `style` attribute) and its own remote-url style stripping, which only
// targets `url(http...)` patterns (see apps/web/src/features/reader/sanitize.ts).
const IMAGE_ALIGN_STYLES: Record<ImageAlign, string> = {
  left: "display: block; margin-left: 0; margin-right: auto;",
  center: "display: block; margin-left: auto; margin-right: auto;",
  right: "display: block; margin-left: auto; margin-right: 0;",
};

function isImageAlign(value: unknown): value is ImageAlign {
  return typeof value === "string" && (IMAGE_ALIGN_VALUES as string[]).includes(value);
}

// Fixed allowlist of widths the toolbar can ever produce (IMAGE_SIZE_PRESETS
// values). `width`'s renderHTML interpolates this value directly into a
// `style` string (`style: \`width: ${value}\``), so — unlike `align`, whose
// renderHTML only ever picks from a hardcoded IMAGE_ALIGN_STYLES map — an
// unvalidated `width` would let any string set on the node's attrs (e.g. via
// updateAttributes/insertContentAt with attrs that didn't come through our
// own toolbar, or a doc loaded from elsewhere) flow straight into the live
// editor's DOM style attribute, including a smuggled second declaration like
// `50%;background:url(http://evil.com/x)`. Gating both renderHTML (the write
// side) and parseHTML (the read side) against this allowlist means the
// safety argument doesn't rest solely on the browser's CSSOM parser being
// well-behaved when *reading* a style attribute back.
const IMAGE_WIDTH_VALUES = new Set<string>(Object.values(IMAGE_SIZE_PRESETS));

function isImageWidth(value: unknown): value is string {
  return typeof value === "string" && IMAGE_WIDTH_VALUES.has(value);
}

/**
 * Extends the base Image node (@tiptap/extension-image) with `width` and
 * `align` attributes, rendered as inline CSS on the <img> element so a saved
 * signature/draft keeps its sizing and placement across reloads. TipTap
 * merges multiple attributes' `style` renderHTML output by CSS property
 * (see @tiptap/core's mergeAttributes), so width and align combine into a
 * single `style` attribute instead of clobbering each other.
 */
export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const width = element.style.width;
          return isImageWidth(width) ? width : null;
        },
        renderHTML: (attributes: { width: string | null }) => {
          if (!isImageWidth(attributes.width)) return {};
          return { style: `width: ${attributes.width}` };
        },
      },
      align: {
        default: null,
        parseHTML: (element: HTMLElement): ImageAlign | null => {
          const { marginLeft, marginRight } = element.style;
          if (marginLeft === "auto" && marginRight === "auto") return "center";
          if (marginRight === "auto") return "left";
          if (marginLeft === "auto") return "right";
          return null;
        },
        renderHTML: (attributes: { align: ImageAlign | null }) => {
          if (!isImageAlign(attributes.align)) return {};
          return { style: IMAGE_ALIGN_STYLES[attributes.align] };
        },
      },
    };
  },
});
