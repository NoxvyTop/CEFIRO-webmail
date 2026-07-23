import { describe, expect, it } from "vitest";
import type { CustomLabel } from "@webmail/shared";
import {
  CANONICAL_LABELS, CUSTOM_LABEL_PALETTE, isLabelNameTaken, labelBackground, labelColor,
  labelDisplayName, mergeLabels, slugifyLabelName, userLabels,
} from "./labels";

describe("labelColor", () => {
  it("is deterministic for the same label", () => {
    expect(labelColor("project-x")).toBe(labelColor("project-x"));
  });

  it("is case-insensitive", () => {
    expect(labelColor("Important")).toBe(labelColor("important"));
    expect(labelColor("URGENT")).toBe(labelColor("urgent"));
  });

  it("returns one of the fixed palette colors", () => {
    const palette = ["#F26565", "#5B8DEF", "#E5A13D", "#34C79A"];
    expect(palette).toContain(labelColor("anything"));
    expect(palette).toContain(labelColor("something-else"));
  });

  it("can produce different colors for different labels", () => {
    // Not `.map(labelColor)` directly: Array#map passes (label, index, array)
    // to its callback, and index would land in labelColor's second
    // (customLabels) parameter position.
    const colors = new Set(["alpha", "beta", "gamma", "delta", "epsilon"].map((label) => labelColor(label)));
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe("labelBackground", () => {
  it("is deterministic and derived from labelColor", () => {
    expect(labelBackground("project-x")).toBe(labelBackground("project-x"));
  });

  it("returns a translucent rgba wrapping the labelColor hex", () => {
    const hex = labelColor("important");
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    expect(labelBackground("important")).toBe(`rgba(${r}, ${g}, ${b}, 0.14)`);
  });
});

describe("fixed spec label palette (docs/design/cefiro/README.md)", () => {
  it("maps 'urgente' to the spec color and 0.14 alpha background", () => {
    expect(labelColor("urgente")).toBe("#F26565");
    expect(labelBackground("urgente")).toBe("rgba(242, 101, 101, 0.14)");
  });

  it("maps 'producto' to the spec color and 0.14 alpha background", () => {
    expect(labelColor("producto")).toBe("#5B8DEF");
    expect(labelBackground("producto")).toBe("rgba(91, 141, 239, 0.14)");
  });

  it("maps 'diseño' to the spec color and 0.15 alpha background (spec's one-off alpha)", () => {
    expect(labelColor("diseño")).toBe("#E5A13D");
    expect(labelBackground("diseño")).toBe("rgba(229, 161, 61, 0.15)");
    expect(labelColor("diseno")).toBe("#E5A13D");
    expect(labelBackground("diseno")).toBe("rgba(229, 161, 61, 0.15)");
  });

  it("maps 'finanzas' to the spec color and 0.14 alpha background", () => {
    expect(labelColor("finanzas")).toBe("#34C79A");
    expect(labelBackground("finanzas")).toBe("rgba(52, 199, 154, 0.14)");
  });

  it("matches the fixed mapping case-insensitively", () => {
    expect(labelColor("URGENTE")).toBe("#F26565");
    expect(labelColor("Producto")).toBe("#5B8DEF");
    expect(labelColor("DISEÑO")).toBe("#E5A13D");
    expect(labelColor("Finanzas")).toBe("#34C79A");
  });

  it("does not collide: each spec label keeps its own color", () => {
    const colors = new Set(["urgente", "producto", "diseño", "finanzas"].map((label) => labelColor(label)));
    expect(colors.size).toBe(4);
  });

  it("uses the hash-based fallback only for labels outside the spec", () => {
    // "important" is not part of the fixed spec map, so it must still resolve
    // through the deterministic hash fallback with the shared 0.14 alpha.
    expect(labelColor("important")).not.toBe(undefined);
    expect(labelBackground("important")).toMatch(/^rgba\(\d+, \d+, \d+, 0\.14\)$/);
  });
});

describe("userLabels", () => {
  it("returns keys whose value is true", () => {
    expect(userLabels({ important: true, urgent: false })).toEqual(["important"]);
  });

  it("excludes system keywords prefixed with $", () => {
    expect(userLabels({ $seen: true, $flagged: true, important: true })).toEqual(["important"]);
  });

  it("excludes false-valued keys even without a $ prefix", () => {
    expect(userLabels({ important: false, urgent: true })).toEqual(["urgent"]);
  });

  it("returns labels sorted alphabetically", () => {
    expect(userLabels({ zeta: true, alpha: true, mid: true })).toEqual(["alpha", "mid", "zeta"]);
  });

  it("returns an empty array when there are no user keywords", () => {
    expect(userLabels({ $seen: true, $flagged: false })).toEqual([]);
  });
});

describe("mergeLabels (CLARO-08/OSCURO-07: ETIQUETAS always shows the taxonomy)", () => {
  it("returns just the 4 canonical labels, in spec order, when there are no real labels", () => {
    expect(mergeLabels([])).toEqual(CANONICAL_LABELS);
    // The stored/filter value is the ASCII-safe JMAP keyword slug "diseno" —
    // NOT the accented "diseño" — because that's what real mail is tagged
    // with (hasKeyword is passed verbatim to JMAP, no accent folding on the
    // server). The accented spelling is a display-only concern, see
    // labelDisplayName() below.
    expect(CANONICAL_LABELS).toEqual(["urgente", "producto", "diseno", "finanzas"]);
  });

  it("appends real labels not covered by the canonical set after the canonical ones", () => {
    expect(mergeLabels(["important", "urgent"])).toEqual([
      "urgente", "producto", "diseno", "finanzas", "important", "urgent",
    ]);
  });

  it("dedupes case-insensitively so a real label matching a canonical one isn't repeated", () => {
    expect(mergeLabels(["Urgente", "PRODUCTO"])).toEqual(["urgente", "producto", "diseno", "finanzas"]);
  });

  it("keeps canonical labels first and preserves the caller's order for extras", () => {
    // Callers (MailPage) already hand mergeLabels a sorted list of real
    // labels, so this only guards that mergeLabels itself doesn't reorder.
    expect(mergeLabels(["zeta", "alpha"])).toEqual([
      "urgente", "producto", "diseno", "finanzas", "zeta", "alpha",
    ]);
  });

  // Regression coverage for the fresh-review MAJOR: canonical "diseño" used
  // to be stored accented, so a real diseno-tagged mail (1) didn't dedupe
  // against it (two chips: "Diseño" and "diseno") and (2) the canonical chip
  // filtered by hasKeyword=diseño, matching zero real mail. Both are wrong.
  it("dedupes the real JMAP slug 'diseno' into the canonical entry (no duplicate chip)", () => {
    expect(mergeLabels(["diseno"])).toEqual(CANONICAL_LABELS);
  });

  it("also dedupes an accented real label 'Diseño' via diacritic-insensitive normalization", () => {
    expect(mergeLabels(["Diseño"])).toEqual(CANONICAL_LABELS);
  });
});

describe("labelDisplayName (accented spec display name for the ASCII-safe canonical slug)", () => {
  it("renders the 'diseno' slug with its spec display name 'Diseño'", () => {
    expect(labelDisplayName("diseno")).toBe("Diseño");
  });

  it("is case-insensitive on the input slug", () => {
    expect(labelDisplayName("DISENO")).toBe("Diseño");
    expect(labelDisplayName("Diseno")).toBe("Diseño");
  });

  it("passes through labels with no display override unchanged (CSS `capitalize` handles casing)", () => {
    expect(labelDisplayName("urgente")).toBe("urgente");
    expect(labelDisplayName("important")).toBe("important");
  });
});

describe("slugifyLabelName (custom label creation: display name -> ASCII JMAP keyword slug)", () => {
  it("lowercases and keeps plain ascii words unchanged", () => {
    expect(slugifyLabelName("Ventas")).toBe("ventas");
  });

  it("strips diacritics, matching the canonical 'diseno' convention", () => {
    expect(slugifyLabelName("Diseño")).toBe("diseno");
  });

  it("joins multiple words with a single hyphen", () => {
    expect(slugifyLabelName("Ventas Q3")).toBe("ventas-q3");
  });

  it("collapses runs of whitespace/symbols into one hyphen and trims edges", () => {
    expect(slugifyLabelName("  Ventas!!  Trimestral  ")).toBe("ventas-trimestral");
  });

  it("returns an empty string for a name with no ascii-alnum content", () => {
    expect(slugifyLabelName("!!!")).toBe("");
  });
});

describe("CUSTOM_LABEL_PALETTE (small brand-safe color picker)", () => {
  it("exposes at least 4 valid 6-digit hex swatches", () => {
    expect(CUSTOM_LABEL_PALETTE.length).toBeGreaterThanOrEqual(4);
    for (const hex of CUSTOM_LABEL_PALETTE) {
      expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("does not reuse any of the 4 fixed canonical label colors, to avoid visual collision with the taxonomy", () => {
    const canonicalColors = ["#F26565", "#5B8DEF", "#E5A13D", "#34C79A"];
    for (const hex of CUSTOM_LABEL_PALETTE) {
      expect(canonicalColors).not.toContain(hex);
    }
  });
});

describe("isLabelNameTaken (dedupe custom vs canonical, CLARO-08/OSCURO-07 style)", () => {
  const existing: CustomLabel[] = [{ slug: "ventas", name: "Ventas", color: "#9B6BDB" }];

  it("is taken when the name slugifies to a canonical label, accented or not", () => {
    expect(isLabelNameTaken("Urgente", [])).toBe(true);
    expect(isLabelNameTaken("Diseño", [])).toBe(true);
    expect(isLabelNameTaken("diseno", [])).toBe(true);
  });

  it("is taken when the name slugifies to an existing custom label's slug (case/diacritic-insensitive)", () => {
    expect(isLabelNameTaken("ventas", existing)).toBe(true);
    expect(isLabelNameTaken("VENTAS", existing)).toBe(true);
  });

  it("is not taken for a genuinely new name", () => {
    expect(isLabelNameTaken("Soporte", existing)).toBe(false);
  });

  it("is not taken for a name that slugifies to empty (caller handles as a required-field error instead)", () => {
    expect(isLabelNameTaken("!!!", existing)).toBe(false);
  });
});

describe("labelColor/labelBackground with a custom label list", () => {
  const custom: CustomLabel[] = [{ slug: "ventas", name: "Ventas", color: "#9B6BDB" }];

  it("resolves a custom label's stored color", () => {
    expect(labelColor("ventas", custom)).toBe("#9B6BDB");
  });

  it("resolves a custom label's color case/diacritic-insensitively", () => {
    expect(labelColor("VENTAS", custom)).toBe("#9B6BDB");
  });

  it("wraps the custom color in the shared 0.14 alpha background, like the hash fallback", () => {
    expect(labelBackground("ventas", custom)).toBe("rgba(155, 107, 219, 0.14)");
  });

  it("still gives canonical labels their fixed color even when a customLabels list is passed", () => {
    expect(labelColor("urgente", custom)).toBe("#F26565");
  });

  it("still falls back to the deterministic hash color for labels absent from both maps", () => {
    expect(labelColor("something-else", custom)).toBe(labelColor("something-else"));
  });

  it("is backward compatible: omitting customLabels behaves exactly as before", () => {
    expect(labelColor("important")).not.toBe(undefined);
    expect(labelBackground("important")).toMatch(/^rgba\(\d+, \d+, \d+, 0\.14\)$/);
  });
});

describe("labelDisplayName with a custom label list", () => {
  const custom: CustomLabel[] = [{ slug: "ventas", name: "Ventas Q3", color: "#9B6BDB" }];

  it("returns the custom label's stored display name for its slug", () => {
    expect(labelDisplayName("ventas", custom)).toBe("Ventas Q3");
  });

  it("still prefers the canonical display override over any (impossible, but defensive) collision", () => {
    expect(labelDisplayName("diseno", custom)).toBe("Diseño");
  });

  it("falls back to the raw label for anything not canonical or custom", () => {
    expect(labelDisplayName("important", custom)).toBe("important");
  });
});

describe("mergeLabels with custom label slugs (always visible in the nav, like canonical)", () => {
  it("appends custom labels after canonical ones even with zero matching mail", () => {
    expect(mergeLabels([], ["ventas"])).toEqual([...CANONICAL_LABELS, "ventas"]);
  });

  it("dedupes a custom label slug against real labels found in mail (no duplicate chip)", () => {
    expect(mergeLabels(["ventas"], ["ventas"])).toEqual([...CANONICAL_LABELS, "ventas"]);
  });

  it("dedupes a custom label slug that collides with a canonical one (defensive)", () => {
    expect(mergeLabels([], ["urgente"])).toEqual(CANONICAL_LABELS);
  });

  it("keeps real, unregistered extras after canonical + custom", () => {
    expect(mergeLabels(["important"], ["ventas"])).toEqual([...CANONICAL_LABELS, "ventas", "important"]);
  });

  it("is backward compatible: omitting customLabelSlugs behaves exactly as before", () => {
    expect(mergeLabels([])).toEqual(CANONICAL_LABELS);
    expect(mergeLabels(["important", "urgent"])).toEqual([
      "urgente", "producto", "diseno", "finanzas", "important", "urgent",
    ]);
  });
});
