import { describe, expect, it } from "vitest";
import { parseBullets } from "./prompts";

describe("parseBullets", () => {
  it("keeps a leading number that belongs to the content", () => {
    // The figure is usually the point of the bullet, so eating it is worse
    // than leaving a stray marker behind.
    expect(parseBullets("- 3 facturas pendientes de pago")).toEqual([
      "3 facturas pendientes de pago",
    ]);
  });

  it("keeps a leading date-like token intact", () => {
    expect(parseBullets("- 2024-Q1 cerró en rojo")).toEqual(["2024-Q1 cerró en rojo"]);
  });

  it("strips the bullet markers models actually emit", () => {
    expect(
      parseBullets("- guion\n* asterisco\n• viñeta\n1. numerado\n2) parentesis", 5),
    ).toEqual(["guion", "asterisco", "viñeta", "numerado", "parentesis"]);
  });

  it("strips a marker written without a space after it", () => {
    expect(parseBullets("-sin espacio")).toEqual(["sin espacio"]);
  });

  it("leaves a line that has no marker alone", () => {
    expect(parseBullets("Sin viñeta")).toEqual(["Sin viñeta"]);
  });

  it("does not mistake a decimal for a numbered marker", () => {
    expect(parseBullets("1.5 millones facturados")).toEqual(["1.5 millones facturados"]);
  });

  it("drops blank and marker-only lines", () => {
    expect(parseBullets("- uno\n\n-\n- dos")).toEqual(["uno", "dos"]);
  });

  it("honours the limit", () => {
    expect(parseBullets("- uno\n- dos\n- tres", 2)).toEqual(["uno", "dos"]);
  });
});
