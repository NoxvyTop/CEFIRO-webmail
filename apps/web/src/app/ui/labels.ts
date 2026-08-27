import type { CustomLabel } from "@webmail/shared";

const LABEL_COLORS = ["#F26565", "#5B8DEF", "#E5A13D", "#34C79A"];

// Small brand-safe palette offered by the "Nueva etiqueta" color picker.
// Deliberately distinct from the 4 fixed canonical colors above (see the
// labels.test.ts invariant) so a custom label never visually reads as one of
// the product's 4-label taxonomy.
export const CUSTOM_LABEL_PALETTE = [
  "#9B6BDB", // violeta
  "#E8639C", // magenta
  "#2FB8C4", // turquesa
  "#7C89A3", // gris azulado
  "#D97757", // terracota
  "#C9A227", // mostaza
  "#6C7BD9", // indigo
  "#4FB477", // salvia
];

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

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// The hash-based palette is a fallback for labels outside the fixed spec map,
// so it keeps the shared 0.14 alpha rather than any per-label alpha.
function hashBackground(label: string): string {
  return hexToRgba(hashColor(label), 0.14);
}

function findCustomLabel(label: string, customLabels: CustomLabel[]): CustomLabel | undefined {
  const key = normalizeLabelKey(label);
  return customLabels.find((custom) => normalizeLabelKey(custom.slug) === key);
}

// `customLabels` defaults to [] so every existing 1-arg call site keeps
// working unchanged — the caller only needs to pass the user's stored custom
// label list (from userPreferences) when it wants those colors resolved
// instead of falling through to the deterministic hash.
//
// Precedence (review finding #1, GH #83): a label backed by a stored custom
// definition ALWAYS uses that definition's own color — even for one of the 4
// former-canonical names (e.g. a user-created "Urgente") — since #83 made
// those creatable/deletable/re-colorable like any other label. FIXED_LABEL_
// STYLE only applies to a label with NO custom definition, i.e. a real,
// discovered JMAP keyword nobody has "claimed" as a custom label. The
// deterministic hash is the last-resort fallback for anything in neither map.
export function labelColor(label: string, customLabels: CustomLabel[] = []): string {
  const custom = findCustomLabel(label, customLabels);
  if (custom) return custom.color;
  const fixed = FIXED_LABEL_STYLE[label.toLowerCase()];
  if (fixed) return fixed.color;
  return hashColor(label);
}

// Same precedence as labelColor above: a custom definition's own color wins
// first (wrapped in the shared 0.14 alpha), the fixed spec background is the
// fallback for an unclaimed discovered keyword.
export function labelBackground(label: string, customLabels: CustomLabel[] = []): string {
  const custom = findCustomLabel(label, customLabels);
  if (custom) return hexToRgba(custom.color, 0.14);
  const fixed = FIXED_LABEL_STYLE[label.toLowerCase()];
  if (fixed) return fixed.background;
  return hashBackground(label);
}

export function userLabels(keywords: Record<string, boolean>): string[] {
  return Object.keys(keywords)
    .filter((key) => keywords[key] && !key.startsWith("$"))
    .sort();
}

// GH #102/#83 superseded the old CLARO-08/OSCURO-07 behavior: the ETIQUETAS
// rail no longer auto-seeds these 4 names — a fresh user starts with zero
// labels and creates their own (mergeLabels() below does not reference this
// array anymore), and any of the 4 names can be created/deleted like any
// other custom label (isLabelNameTaken() no longer reserves them either).
//
// The array stays exported because it still backs the fixed spec color/name
// styling (FIXED_LABEL_STYLE / LABEL_DISPLAY_OVERRIDES below, keyed directly
// by slug — unrelated to this array) and ThreadView's "Label as" apply-menu,
// which still offers these 4 as always-known, always-applicable keywords.
//
// These are the STORED/FILTER values — the JMAP keyword slugs real mail is
// actually tagged with, and what gets sent verbatim as `hasKeyword` when one
// of these is applied/selected. "diseño" is spelled "diseno" here on
// purpose: legacy IMAP/JMAP keyword atoms are ASCII-safe, so the real
// keyword is the unaccented slug — the server does no accent folding.
// Filtering by the entry must use that same slug, or the filter matches
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

// `customLabels` defaults to [] for the same backward-compatibility reason
// as labelColor/labelBackground above. Same precedence as those two (review
// finding #1): a custom label's own stored name always wins.
// LABEL_DISPLAY_OVERRIDES (the accented "Diseño" spelling) only applies to a
// discovered "diseno" keyword with no custom definition — a user who names
// their OWN label "Diseño" already gets that exact spelling back from
// `custom.name`, no override needed.
export function labelDisplayName(label: string, customLabels: CustomLabel[] = []): string {
  const custom = findCustomLabel(label, customLabels);
  if (custom) return custom.name;
  const override = LABEL_DISPLAY_OVERRIDES[label.toLowerCase()];
  if (override) return override;
  return label;
}

// Case- and diacritic-insensitive comparison key: JMAP keywords are
// ASCII-safe slugs, but a real label could in principle arrive accented
// (e.g. a different client writing "Diseño") — normalizing here means that
// still dedupes into the canonical "diseno" entry instead of showing as a
// separate, orphaned chip.
const COMBINING_DIACRITICS_PATTERN = /[\u0300-\u036f]/g;

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(COMBINING_DIACRITICS_PATTERN, "");
}

function normalizeLabelKey(label: string): string {
  return stripDiacritics(label).toLowerCase();
}

// Custom label creation: normalizes a free-form display name into the
// ASCII-safe JMAP keyword slug used to store/filter it, following the same
// convention as the canonical "diseno" slug (accents stripped, lowercased,
// non-alnum runs collapsed to a single hyphen, edges trimmed). Returns "" for
// a name with no ascii-alnum content — callers treat that as invalid.
export function slugifyLabelName(name: string): string {
  return stripDiacritics(name.trim().toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Design decision (dedupe custom vs custom, GH #83): a custom label whose
// name slugifies to an ALREADY-EXISTING custom slug (case/diacritic
// insensitive) must not be created — it would produce two chips backing the
// same JMAP keyword. The 4 former-canonical names are no longer reserved: a
// user creating a label named "Urgente" gets an ordinary, deletable custom
// label, same as any other name — there is nothing left to collide with
// until they (or someone else's mail client) actually create one.
export function isLabelNameTaken(name: string, customLabels: CustomLabel[]): boolean {
  const slug = slugifyLabelName(name);
  if (slug.length === 0) return false;
  const key = normalizeLabelKey(slug);
  return customLabels.some((custom) => normalizeLabelKey(custom.slug) === key);
}

// GH #102/#83: the taxonomy is entirely the user's own — no canonical
// scaffolding is injected anymore. Merges the user's custom labels (always
// shown, even with zero matching mail) with whatever other real labels were
// found in the loaded messages: custom labels first in their stored order,
// then any remaining real labels not already covered — case- and
// diacritic-insensitively deduped throughout. A fresh user with no custom
// labels and no keyword-bearing mail gets an empty array (zero label rows).
export function mergeLabels(realLabels: string[], customLabelSlugs: string[] = []): string[] {
  const seen = new Set<string>();
  const customExtras: string[] = [];
  for (const slug of customLabelSlugs) {
    const key = normalizeLabelKey(slug);
    if (seen.has(key)) continue;
    seen.add(key);
    customExtras.push(slug);
  }
  const realExtras = realLabels.filter((label) => !seen.has(normalizeLabelKey(label)));
  return [...customExtras, ...realExtras];
}
