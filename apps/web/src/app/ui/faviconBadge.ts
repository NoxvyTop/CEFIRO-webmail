// GH #338: an unread badge painted over the favicon.
//
// With the tab in the foreground the app gave no sign that mail had arrived:
// the title was always "Céfiro" and the icon never changed, so the only clue
// was the list quietly refetching. The tab strip is where a mail client is
// looked at most of the time, which is why the count goes there.
//
// The drawing is split from the DOM/canvas glue on purpose: jsdom has no canvas
// implementation, so the geometry is asserted against a fake surface while the
// glue only has to degrade cleanly when `getContext` returns null.

/** The icon shipped in public/, and the state the badge is removed back to. */
export const BASE_FAVICON_HREF = "/favicon.svg";

/** Square canvas edge, in px. Large enough for the 2x favicon browsers ask for. */
export const FAVICON_BADGE_SIZE = 64;

/** Above this the number stops being legible at 16px, so it becomes "99+". */
export const FAVICON_BADGE_MAX = 99;

const BADGE_FILL = "#E5484D";
const BADGE_TEXT = "#FFFFFF";

/**
 * The slice of `CanvasRenderingContext2D` the badge uses. Declared rather than
 * imported so tests can hand in a plain object — jsdom cannot produce a real
 * one, and a badge that is only ever drawn in a browser would otherwise be
 * untestable.
 */
export type BadgeSurface = {
  // Widened to the real context's union so a CanvasRenderingContext2D is
  // assignable; the badge only ever writes a colour string into it.
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  clearRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: CanvasImageSource, x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
};

/** What the badge shows for `count`, capped so it stays readable at 16px. */
export function badgeLabel(count: number): string {
  return count > FAVICON_BADGE_MAX ? `${FAVICON_BADGE_MAX}+` : String(count);
}

/**
 * Paint the app icon and then the unread counter over its bottom-right corner.
 * `icon` may be null (the image has not loaded yet, or failed): the badge is
 * still drawn, because a bare counter is more useful than no signal.
 */
export function drawFaviconBadge(
  surface: BadgeSurface,
  icon: CanvasImageSource | null,
  count: number,
): void {
  const size = FAVICON_BADGE_SIZE;
  surface.clearRect(0, 0, size, size);
  if (icon) surface.drawImage(icon, 0, 0, size, size);

  const label = badgeLabel(count);
  // A two-or-three character label needs a wider disc than a single digit, so
  // the radius grows with the text instead of clipping it.
  const radius = label.length > 2 ? size * 0.36 : size * 0.3;
  const centre = size - radius;

  surface.beginPath();
  surface.fillStyle = BADGE_FILL;
  surface.arc(centre, centre, radius, 0, Math.PI * 2);
  surface.fill();

  surface.fillStyle = BADGE_TEXT;
  surface.font = `bold ${Math.round(radius * 1.15)}px sans-serif`;
  surface.textAlign = "center";
  surface.textBaseline = "middle";
  surface.fillText(label, centre, centre);
}

/**
 * Put the badge on the document's icon, or take it off when nothing is unread.
 *
 * Every failure mode degrades to the plain icon rather than throwing: no icon
 * link, no canvas support, an icon that will not load. A decoration must never
 * be able to break the tab it decorates.
 */
export function applyFaviconBadge(count: number): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;

  if (count <= 0) {
    link.setAttribute("href", BASE_FAVICON_HREF);
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = FAVICON_BADGE_SIZE;
  canvas.height = FAVICON_BADGE_SIZE;
  const surface = canvas.getContext("2d");
  if (!surface) return;

  const icon = new Image();
  icon.addEventListener("load", () => {
    drawFaviconBadge(surface, icon, count);
    link.setAttribute("href", canvas.toDataURL("image/png"));
  });
  icon.src = BASE_FAVICON_HREF;
}
