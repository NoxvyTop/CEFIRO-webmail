import { describe, expect, it } from "vitest";
import { labelBackground, labelColor, userLabels } from "./labels";

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
    const colors = new Set(["alpha", "beta", "gamma", "delta", "epsilon"].map(labelColor));
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
