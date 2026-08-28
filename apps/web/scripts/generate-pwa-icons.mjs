// GH #350: generates the PWA icon set from the Cefiro mark, with no image
// dependency at all.
//
// Why hand-rolled rather than `sharp`/`resvg`: neither is installed, both are
// native modules with prebuilt binaries per platform, and the whole job is four
// small square images built from three strokes and two arcs. A rasteriser for
// exactly that plus a minimal PNG writer (node:zlib does the compression) is
// far less to carry than a native toolchain in every install and CI image.
//
// The geometry mirrors public/favicon.svg (viewBox 0 0 40 40, stroke #6FE3C1,
// width 2.6, round caps). Its two `a3.6 3.6 ...` curls have a chord marginally
// longer than the diameter, which per SVG's arc rules scales the radius up to
// chord/2 - so each is a semicircle about the chord midpoint, computed below.
//
// Run: node apps/web/scripts/generate-pwa-icons.mjs
// The output is committed; re-run it only when the mark changes.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VIEWBOX = 40;
const STROKE_WIDTH = 2.6;
const ACCENT = [0x6f, 0xe3, 0xc1];
const BACKGROUND = [0x0a, 0x0b, 0x10];
const WHITE = [0xff, 0xff, 0xff];

// Supersampling factor per axis. 4 gives 16 samples per pixel, which is plenty
// for round caps at 192px and still instant at 512px.
const SAMPLES = 4;

/** The mark as stroke primitives, in the favicon's own 40x40 coordinates. */
const MARK = [
  { kind: "segment", from: [9, 15], to: [22, 15] },
  { kind: "arc", centre: [20.2, 11.85], radius: 3.62796, from: 60.2551, to: -119.7449 },
  { kind: "segment", from: [7, 21], to: [26, 21] },
  { kind: "arc", centre: [27.8, 24.15], radius: 3.62796, from: -119.7449, to: 60.2551 },
  { kind: "segment", from: [9, 27], to: [19, 27] },
];

function distanceToSegment(x, y, [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function distanceToArc(x, y, arc) {
  const dx = x - arc.centre[0];
  const dy = y - arc.centre[1];
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const low = Math.min(arc.from, arc.to);
  const high = Math.max(arc.from, arc.to);
  // Bring the sample's angle into the same turn as the arc before comparing.
  while (angle < low - 180) angle += 360;
  while (angle > high + 180) angle -= 360;
  if (angle >= low && angle <= high) return Math.abs(Math.hypot(dx, dy) - arc.radius);
  // Outside the sweep the nearest point is an endpoint, which is what gives
  // the stroke its round caps for free.
  const cap = (degrees) => [
    arc.centre[0] + arc.radius * Math.cos((degrees * Math.PI) / 180),
    arc.centre[1] + arc.radius * Math.sin((degrees * Math.PI) / 180),
  ];
  const [ax, ay] = cap(arc.from);
  const [bx, by] = cap(arc.to);
  return Math.min(Math.hypot(x - ax, y - ay), Math.hypot(x - bx, y - by));
}

/** Whether one sample point falls inside the stroked mark. */
function insideMark(x, y) {
  const half = STROKE_WIDTH / 2;
  for (const primitive of MARK) {
    const distance =
      primitive.kind === "segment"
        ? distanceToSegment(x, y, primitive.from, primitive.to)
        : distanceToArc(x, y, primitive);
    if (distance <= half) return true;
  }
  return false;
}

/** Rounded-square test in viewBox units, for the non-maskable app tile. */
function insideRoundedSquare(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), VIEWBOX - radius);
  const cy = Math.min(Math.max(y, radius), VIEWBOX - radius);
  const dx = x - cx;
  const dy = y - cy;
  // Inside the straight edges, or inside one of the four corner discs.
  if (dx === 0 || dy === 0) return x >= 0 && x <= VIEWBOX && y >= 0 && y <= VIEWBOX;
  return Math.hypot(dx, dy) <= radius;
}

/**
 * Renders one icon to an RGBA buffer.
 *
 * `scale` shrinks the mark towards the centre - a maskable icon must keep its
 * content inside the 80% safe zone, because the launcher may crop the rest.
 */
function render({ size, background, stroke, scale = 1, rounded = false }) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = VIEWBOX / size / SAMPLES;
  const centre = VIEWBOX / 2;
  const cornerRadius = VIEWBOX * 0.22;
  const total = SAMPLES * SAMPLES;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let markHits = 0;
      let backgroundHits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px * VIEWBOX) / size + (sx + 0.5) * step;
          const y = (py * VIEWBOX) / size + (sy + 0.5) * step;
          if (background && (!rounded || insideRoundedSquare(x, y, cornerRadius))) {
            backgroundHits += 1;
          }
          // The mark is drawn at `scale` about the icon centre, so the sample
          // is mapped back into unscaled space instead of scaling the geometry.
          const mx = centre + (x - centre) / scale;
          const my = centre + (y - centre) / scale;
          if (insideMark(mx, my)) markHits += 1;
        }
      }

      const markAlpha = markHits / total;
      const backgroundAlpha = background ? backgroundHits / total : 0;
      // Mark over background, resolved back to a straight-alpha pixel.
      const alpha = markAlpha + backgroundAlpha * (1 - markAlpha);
      if (alpha === 0) continue;
      const offset = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const under = background ? background[channel] * backgroundAlpha * (1 - markAlpha) : 0;
        pixels[offset + channel] = Math.round((stroke[channel] * markAlpha + under) / alpha);
      }
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Minimal PNG writer: 8-bit RGBA, no interlace, filter 0 on every scanline. */
function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row += 1) {
    raw[row * (stride + 1)] = 0;
    pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const OUTPUT = fileURLToPath(new URL("../public/", import.meta.url));

const ICONS = [
  // `purpose: any` - a rounded app tile, so it reads as an icon on a launcher
  // rather than as strokes floating on nothing.
  {
    file: "icon-192.png",
    size: 192,
    background: BACKGROUND,
    stroke: ACCENT,
    scale: 0.7,
    rounded: true,
  },
  {
    file: "icon-512.png",
    size: 512,
    background: BACKGROUND,
    stroke: ACCENT,
    scale: 0.7,
    rounded: true,
  },
  // `purpose: maskable` - full-bleed background, mark inside the 80% safe zone.
  {
    file: "icon-maskable-512.png",
    size: 512,
    background: BACKGROUND,
    stroke: ACCENT,
    scale: 0.58,
  },
  // The notification badge: Android renders it as a MASK, so only the alpha
  // channel survives - it must be monochrome on transparent.
  { file: "badge-96.png", size: 96, background: null, stroke: WHITE, scale: 0.85 },
];

for (const icon of ICONS) {
  const pixels = render(icon);
  writeFileSync(`${OUTPUT}${icon.file}`, encodePng(pixels, icon.size));
  console.log(`wrote public/${icon.file} (${icon.size}x${icon.size})`);
}
