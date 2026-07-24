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

describe("mergeLabels (#102/#83: no seeded taxonomy — every label is user-owned)", () => {
  it("returns an empty array for a fresh user: no custom labels, no real labels (#102)", () => {
    expect(mergeLabels([])).toEqual([]);
    expect(mergeLabels([], [])).toEqual([]);
  });

  it("does not auto-inject the former-canonical names — they are ordinary, optional labels now (#83)", () => {
    expect(mergeLabels([])).not.toEqual(expect.arrayContaining(["urgente"]));
    expect(mergeLabels([])).not.toEqual(expect.arrayContaining(CANONICAL_LABELS));
  });

  it("returns just the user's custom labels, in stored order, when there are no real labels", () => {
    expect(mergeLabels([], ["ventas", "urgente"])).toEqual(["ventas", "urgente"]);
  });

  it("appends real labels not covered by the custom set after the custom ones", () => {
    expect(mergeLabels(["important", "urgent"], ["ventas"])).toEqual(["ventas", "important", "urgent"]);
  });

  it("dedupes case-insensitively so a real label matching a custom one isn't repeated", () => {
    expect(mergeLabels(["Ventas", "URGENTE"], ["ventas", "urgente"])).toEqual(["ventas", "urgente"]);
  });

  it("keeps custom labels first and preserves the caller's order for extras", () => {
    // Callers (MailPage) already hand mergeLabels a sorted list of real
    // labels, so this only guards that mergeLabels itself doesn't reorder.
    expect(mergeLabels(["zeta", "alpha"], ["ventas"])).toEqual(["ventas", "zeta", "alpha"]);
  });

  // Regression coverage carried over from the old canonical-scaffolding
  // suite: a real accented label must still dedupe against its ASCII-slug
  // custom-label counterpart instead of showing as two separate chips.
  it("dedupes an accented real label against its ASCII custom-label slug (diacritic-insensitive)", () => {
    expect(mergeLabels(["Diseño"], ["diseno"])).toEqual(["diseno"]);
  });

  it("is backward compatible: omitting customLabelSlugs is a plain real-labels passthrough", () => {
    expect(mergeLabels(["important", "urgent"])).toEqual(["important", "urgent"]);
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

describe("isLabelNameTaken (dedupe against the user's own custom labels; #83: no reserved canonical names)", () => {
  const existing: CustomLabel[] = [{ slug: "ventas", name: "Ventas", color: "#9B6BDB" }];

  it("is NOT taken for the former-canonical names — #83 they're no longer reserved/special", () => {
    expect(isLabelNameTaken("Urgente", [])).toBe(false);
    expect(isLabelNameTaken("Diseño", [])).toBe(false);
    expect(isLabelNameTaken("diseno", [])).toBe(false);
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

  it("falls back to the fixed display override for a slug absent from this particular customLabels list", () => {
    // `custom` here only has "ventas" — no actual collision with "diseno". A
    // REAL collision (a custom label whose own slug is "diseno") now takes
    // the opposite precedence — see the reordered-precedence suite below.
    expect(labelDisplayName("diseno", custom)).toBe("Diseño");
  });

  it("falls back to the raw label for anything not canonical or custom", () => {
    expect(labelDisplayName("important", custom)).toBe("important");
  });
});

// Review finding #1: GH #83 made the 4 former-canonical names ordinary,
// user-creatable custom labels — so a custom label's OWN stored color/name
// must win over FIXED_LABEL_STYLE/LABEL_DISPLAY_OVERRIDES, or a user who
// picks their own color for "Urgente" gets it silently overridden by the
// fixed brand red. The fixed styling now only applies to a label with NO
// custom definition — i.e. a real, discovered JMAP keyword nobody has
// "claimed" as a custom label.
describe("labelColor/labelBackground/labelDisplayName precedence: a custom label's own definition wins (review finding #1)", () => {
  it("a custom label named 'Urgente' (slug 'urgente') keeps its own picked color and typed name", () => {
    const custom: CustomLabel[] = [{ slug: "urgente", name: "Urgente", color: "#9B6BDB" }];
    expect(labelColor("urgente", custom)).toBe("#9B6BDB");
    expect(labelBackground("urgente", custom)).toBe("rgba(155, 107, 219, 0.14)");
    expect(labelDisplayName("urgente", custom)).toBe("Urgente");
  });

  it("a discovered 'urgente' keyword with NO custom definition still gets the fixed brand red", () => {
    expect(labelColor("urgente", [])).toBe("#F26565");
    expect(labelBackground("urgente", [])).toBe("rgba(242, 101, 101, 0.14)");
    // No display override for "urgente" — CSS `capitalize` renders it
    // "Urgente" visually (see labelDisplayName's own unit tests above).
    expect(labelDisplayName("urgente", [])).toBe("urgente");
  });

  it("a custom label named 'Diseño' (slug 'diseno') keeps its own color/name over the fixed accent override", () => {
    const custom: CustomLabel[] = [{ slug: "diseno", name: "Diseño", color: "#2FB8C4" }];
    expect(labelColor("diseno", custom)).toBe("#2FB8C4");
    expect(labelDisplayName("diseno", custom)).toBe("Diseño");
  });

  it("a discovered 'diseno' keyword with NO custom definition still uses the fixed color and 'Diseño' override", () => {
    expect(labelColor("diseno", [])).toBe("#E5A13D");
    expect(labelDisplayName("diseno", [])).toBe("Diseño");
  });
});

describe("mergeLabels: custom label slugs are always visible in the nav (#102/#83 taxonomy = the user's own labels)", () => {
  it("shows custom labels even with zero matching mail", () => {
    expect(mergeLabels([], ["ventas"])).toEqual(["ventas"]);
  });

  it("dedupes a custom label slug against a real label found in mail (no duplicate chip)", () => {
    expect(mergeLabels(["ventas"], ["ventas"])).toEqual(["ventas"]);
  });

  it("keeps real, unregistered extras after the custom labels", () => {
    expect(mergeLabels(["important"], ["ventas"])).toEqual(["ventas", "important"]);
  });

  it("a custom label named after a former-canonical slug (e.g. 'urgente') behaves like any other custom label", () => {
    expect(mergeLabels([], ["urgente"])).toEqual(["urgente"]);
  });
});
