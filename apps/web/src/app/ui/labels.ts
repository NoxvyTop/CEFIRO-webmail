const LABEL_COLORS = ["#F26565", "#5B8DEF", "#E5A13D", "#34C79A"];

// Fixed palette from docs/design/cefiro/README.md — same in both themes.
// "diseno" covers the unaccented JMAP keyword slug alongside the accented
// display spelling "diseño".
const FIXED_LABEL_STYLE: Record<string, { color: string; background: string }> = {
  urgente: { color: "#F26565", background: "rgba(242, 101, 101, 0.14)" },
  producto: { color: "#5B8DEF", background: "rgba(91, 141, 239, 0.14)" },
  "diseño": { color: "#E5A13D", background: "rgba(229, 161, 61, 0.15)" },
  diseno: { color: "#E5A13D", background: "rgba(229, 161, 61, 0.15)" },
  finanzas: { color: "#34C79A", background: "rgba(52, 199, 154, 0.14)" },
};

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function hashColor(label: string): string {
  return LABEL_COLORS[hashString(label.toLowerCase()) % LABEL_COLORS.length]!;
}

// The hash-based palette is a fallback for labels outside the fixed spec map,
// so it keeps the shared 0.14 alpha rather than any per-label alpha.
function hashBackground(label: string): string {
  const hex = hashColor(label);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.14)`;
}

export function labelColor(label: string): string {
  const fixed = FIXED_LABEL_STYLE[label.toLowerCase()];
  return fixed ? fixed.color : hashColor(label);
}

export function labelBackground(label: string): string {
  const fixed = FIXED_LABEL_STYLE[label.toLowerCase()];
  return fixed ? fixed.background : hashBackground(label);
}

export function userLabels(keywords: Record<string, boolean>): string[] {
  return Object.keys(keywords)
    .filter((key) => keywords[key] && !key.startsWith("$"))
    .sort();
}

// CLARO-08/OSCURO-07: the ETIQUETAS rail must never disappear on a fresh
// mailbox — it always shows the product's 4-label taxonomy (spec order),
// regardless of what's actually present in the loaded messages.
export const CANONICAL_LABELS = ["urgente", "producto", "diseño", "finanzas"];

// Merges the canonical taxonomy with whatever real labels were found in the
// loaded messages: canonical labels always come first in spec order, real
// labels not already covered (case-insensitively) are appended after.
export function mergeLabels(realLabels: string[]): string[] {
  const canonicalLower = new Set(CANONICAL_LABELS.map((label) => label.toLowerCase()));
  const extras = realLabels.filter((label) => !canonicalLower.has(label.toLowerCase()));
  return [...CANONICAL_LABELS, ...extras];
}
