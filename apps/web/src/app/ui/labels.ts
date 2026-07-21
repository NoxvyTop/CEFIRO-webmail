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
//
// These are the STORED/FILTER values — the JMAP keyword slugs real mail is
// actually tagged with, and what gets sent verbatim as `hasKeyword` when a
// canonical chip is clicked. "diseño" is spelled "diseno" here on purpose:
// legacy IMAP/JMAP keyword atoms are ASCII-safe, so the real keyword is the
// unaccented slug — the server does no accent folding. Selecting the
// canonical entry must filter by that same slug, or the filter matches
// nothing. The accented spec display name ("Diseño") is a rendering-only
// concern, see labelDisplayName() below.
export const CANONICAL_LABELS = ["urgente", "producto", "diseno", "finanzas"];

// Canonical labels whose spec display name isn't a pure-casing transform of
// their stored slug need an explicit override here — CSS `capitalize` can
// only uppercase the first letter of what's already in the string, it can't
// add a diacritic that isn't there. Everything else (Urgente, Producto,
// Finanzas, and any real label) is fine with plain CSS capitalize, so it
// passes through unchanged.
const LABEL_DISPLAY_OVERRIDES: Record<string, string> = {
  diseno: "Diseño",
};

export function labelDisplayName(label: string): string {
  return LABEL_DISPLAY_OVERRIDES[label.toLowerCase()] ?? label;
}

// Case- and diacritic-insensitive comparison key: JMAP keywords are
// ASCII-safe slugs, but a real label could in principle arrive accented
// (e.g. a different client writing "Diseño") — normalizing here means that
// still dedupes into the canonical "diseno" entry instead of showing as a
// separate, orphaned chip.
const COMBINING_DIACRITICS_PATTERN = new RegExp("[\\u0300-\\u036f]", "g");

function normalizeLabelKey(label: string): string {
  return label.normalize("NFD").replace(COMBINING_DIACRITICS_PATTERN, "").toLowerCase();
}

// Merges the canonical taxonomy with whatever real labels were found in the
// loaded messages: canonical labels always come first in spec order, real
// labels not already covered (case- and diacritic-insensitively) are
// appended after.
export function mergeLabels(realLabels: string[]): string[] {
  const canonicalKeys = new Set(CANONICAL_LABELS.map(normalizeLabelKey));
  const extras = realLabels.filter((label) => !canonicalKeys.has(normalizeLabelKey(label)));
  return [...CANONICAL_LABELS, ...extras];
}
