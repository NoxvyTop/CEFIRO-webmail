import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// GH #350: the design doc promises an installed-PWA surface, but index.html had
// no manifest, no theme-color and no PNG icons — so the app could not be
// installed, and iOS Safari (which only delivers Web Push to an installed,
// standalone PWA) could never receive a push at all.
//
// These are static files served straight from public/, outside every import
// graph, so nothing else in the suite can reach them. Asserted here as the
// contract they are: a manifest whose icons must actually exist on disk.

const root = process.cwd();
const manifest = JSON.parse(
  readFileSync(resolve(root, "public/manifest.webmanifest"), "utf8"),
) as {
  name: string;
  short_name: string;
  display: string;
  start_url: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};
const indexHtml = readFileSync(resolve(root, "index.html"), "utf8");

describe("PWA manifest", () => {
  it("declares a standalone app", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.name).toContain("Céfiro");
    expect(manifest.short_name).toBe("Céfiro");
  });

  it("ships the 192 and 512 icons Chrome requires for installability", () => {
    const any = manifest.icons.filter((icon) => (icon.purpose ?? "any").includes("any"));
    expect(any.map((icon) => icon.sizes).sort()).toEqual(["192x192", "512x512"]);
    for (const icon of any) expect(icon.type).toBe("image/png");
  });

  it("ships a maskable icon so Android does not letterbox the app tile", () => {
    const maskable = manifest.icons.filter((icon) => icon.purpose?.includes("maskable"));
    expect(maskable).toHaveLength(1);
    expect(maskable[0]?.sizes).toBe("512x512");
    expect(maskable[0]?.type).toBe("image/png");
  });

  it("points every icon at a file that exists", () => {
    for (const icon of manifest.icons) {
      expect(existsSync(resolve(root, "public", icon.src.replace(/^\//, "")))).toBe(true);
    }
  });

  it("uses the app's own colours", () => {
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("index.html PWA head", () => {
  it("links the manifest", () => {
    expect(indexHtml).toContain('rel="manifest"');
    expect(indexHtml).toContain("/manifest.webmanifest");
  });

  // One theme-color per scheme: the browser chrome around the installed app
  // has to follow the theme the user is actually in, not the light default
  // index.html hardcodes before themeInit runs.
  it("declares a theme-color for each theme", () => {
    expect(indexHtml).toContain('media="(prefers-color-scheme: dark)"');
    expect(indexHtml).toContain('media="(prefers-color-scheme: light)"');
    expect(indexHtml.match(/name="theme-color"/g)).toHaveLength(2);
  });

  it("offers the PNG touch icon iOS uses for a home-screen install", () => {
    expect(indexHtml).toContain('rel="apple-touch-icon"');
  });
});
