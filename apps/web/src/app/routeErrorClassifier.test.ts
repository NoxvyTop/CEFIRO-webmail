import { describe, expect, it } from "vitest";
import { isChunkLoadFailure } from "./routeErrorClassifier";

// GH #345: after a deploy, a hashed chunk (Composer, Settings, pdfjs) that a
// still-open tab tries to lazy-import 404s, because that exact filename no
// longer exists on the server. Different browsers phrase the resulting
// rejection differently — this has to recognise all of them, not just
// Chrome's, or most visitors get the generic fallback instead of "reload".
describe("isChunkLoadFailure", () => {
  it("recognises Chrome/Vite's message", () => {
    expect(isChunkLoadFailure(new Error("Failed to fetch dynamically imported module: /assets/Composer-abc123.js"))).toBe(true);
  });

  it("recognises the plain network failure a stale chunk 404 can also surface as", () => {
    expect(isChunkLoadFailure(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("recognises Firefox's phrasing", () => {
    expect(isChunkLoadFailure(new Error("error loading dynamically imported module"))).toBe(true);
  });

  it("recognises Safari's phrasing", () => {
    expect(isChunkLoadFailure(new Error("Importing a module script failed"))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isChunkLoadFailure(new Error("FAILED TO FETCH DYNAMICALLY IMPORTED MODULE"))).toBe(true);
  });

  it("returns false for an unrelated error", () => {
    expect(isChunkLoadFailure(new Error("Cannot read properties of null"))).toBe(false);
  });

  it("returns false for a non-Error value", () => {
    expect(isChunkLoadFailure("Failed to fetch dynamically imported module")).toBe(false);
    expect(isChunkLoadFailure(null)).toBe(false);
    expect(isChunkLoadFailure(undefined)).toBe(false);
  });
});
