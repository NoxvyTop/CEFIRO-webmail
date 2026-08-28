import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #348: es.json mixes voseo ("respondés", "tenés", "Entrá", "pedí", "Probá")
// into a translation that is tuteo everywhere else ("tienes", "puedes",
// "Inténtalo"...). A raw string scan is the simplest regression guard against
// a voseo conjugation slipping back in — no need to know which key it lives
// under, just that the copy stays consistently tuteo.
const esRaw = readFileSync(
  resolve(process.cwd(), "src/app/locales/es.json"),
  "utf8",
);

describe("es.json register consistency (#348)", () => {
  it.each([
    "respondés",
    "reenviás",
    "tenés",
    "Entrá ",
    "pedí ",
    "Probá ",
  ])("does not use the voseo conjugation %j", (voseoForm) => {
    expect(esRaw.includes(voseoForm)).toBe(false);
  });
});
