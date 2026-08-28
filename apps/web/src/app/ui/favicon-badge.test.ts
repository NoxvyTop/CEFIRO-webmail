import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyFaviconBadge,
  badgeLabel,
  drawFaviconBadge,
  FAVICON_BADGE_MAX,
  FAVICON_BADGE_SIZE,
  BASE_FAVICON_HREF,
  type BadgeSurface,
} from "./faviconBadge";

// GH #338: with the tab in the foreground there was no sign of new mail at all
// — the title was always "Céfiro" and the favicon never changed.

function fakeSurface() {
  const calls: string[] = [];
  const surface: BadgeSurface = {
    fillStyle: "" as string,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    clearRect: () => calls.push("clearRect"),
    drawImage: () => calls.push("drawImage"),
    beginPath: () => calls.push("beginPath"),
    arc: () => calls.push("arc"),
    fill: () => calls.push("fill"),
    fillText: (text) => calls.push(`fillText:${text}`),
  };
  return { surface, calls };
}

afterEach(() => {
  document.head.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("badgeLabel", () => {
  it("shows the count as-is up to the cap", () => {
    expect(badgeLabel(1)).toBe("1");
    expect(badgeLabel(FAVICON_BADGE_MAX)).toBe("99");
  });

  it("caps a big count instead of drawing an unreadable number", () => {
    expect(badgeLabel(FAVICON_BADGE_MAX + 1)).toBe("99+");
    expect(badgeLabel(4321)).toBe("99+");
  });
});

describe("drawFaviconBadge", () => {
  it("draws the icon first and the counter over it", () => {
    const { surface, calls } = fakeSurface();

    drawFaviconBadge(surface, null, 3);

    expect(calls[0]).toBe("clearRect");
    expect(calls).toContain("arc");
    expect(calls).toContain("fillText:3");
    // The badge must sit ON the icon, not under it.
    expect(calls.indexOf("arc")).toBeGreaterThan(calls.indexOf("clearRect"));
  });

  it("paints the app icon when one was loaded", () => {
    const { surface, calls } = fakeSurface();

    drawFaviconBadge(surface, {} as CanvasImageSource, 3);

    expect(calls).toContain("drawImage");
  });
});

describe("applyFaviconBadge", () => {
  it("restores the plain icon when nothing is unread", () => {
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = "data:image/png;base64,stale";
    document.head.append(link);

    applyFaviconBadge(0);

    expect(link.getAttribute("href")).toBe(BASE_FAVICON_HREF);
  });

  it("does nothing at all when the document has no icon link", () => {
    expect(() => applyFaviconBadge(4)).not.toThrow();
  });

  // jsdom ships no canvas implementation, so getContext() is null there — the
  // same shape as a browser with canvas disabled. Degrading to the plain icon
  // is the point: a missing badge must never break the tab.
  it("leaves the icon alone when the browser gives no 2d context", () => {
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = BASE_FAVICON_HREF;
    document.head.append(link);

    applyFaviconBadge(4);

    expect(link.getAttribute("href")).toBe(BASE_FAVICON_HREF);
  });

  it("sizes the canvas for a favicon", () => {
    expect(FAVICON_BADGE_SIZE).toBeGreaterThanOrEqual(32);
  });
});
