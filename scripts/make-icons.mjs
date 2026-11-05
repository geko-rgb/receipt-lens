#!/usr/bin/env node
/**
 * Ticket 17 — the PWA icons of DECISIONS/0027 W11, written as PNGs without an image library.
 *
 * The alternative was a dependency (`sharp`, `pngjs`, an ImageMagick shell-out) to draw three flat tiles.
 * `HANDOFF`'s standing rules make that the wrong trade: postinstalls are reviewed before allowing, and a
 * native image library is the kind of package that has one. A PNG is a signature, IHDR, a zlib IDAT and IEND,
 * which `node:zlib` and a CRC table cover in about sixty lines. The colours are the ones `src/app.css`
 * already uses, so a launcher icon and the page cannot disagree.
 *
 * Running it as a CLI prints each size, its byte length and its SHA-256 — that is `pnpm verify:icons`, and it
 * is why the bytes are derived at build time rather than committed as binaries: a generated icon is
 * re-derivable, a committed one is a blob a reader has to trust.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const SURFACE = [0xef, 0xe9, 0xdc]; // app.css filled surface
const PAPER = [0xfb, 0xfa, 0xf7]; // app.css page background
const INK = [0x26, 0x22, 0x1c]; // app.css text

/**
 * The artwork as a per-pixel predicate over integer rectangles.
 *
 * Coordinates are rounded from a 512-unit design grid, so a 192 tile is the same picture rather than a
 * resample of one, and nothing depends on font rendering, antialiasing or the host's image stack. `inset` is
 * the only difference between a normal and a maskable tile: a launcher masks a maskable icon to a circle, a
 * squircle or a diamond and guarantees only the central 80%, so that tile draws the same receipt smaller.
 */
const draw = (size, { inset }) => {
  const scale = size / 512;
  const px = (value) => Math.round(value * scale);
  const x0 = Math.round(size * inset);
  const y0 = Math.round(size * inset);
  const x1 = size - x0;
  const y1 = size - y0;
  const bodyBottom = y0 + Math.round((y1 - y0) * 0.84);
  const tabWidth = (x1 - x0) / 8;

  // four ink lines on the paper: a header, two items, and the short total the product is about
  const lines = [
    [0.18, 0.26, 0.82, 0.32],
    [0.24, 0.4, 0.76, 0.45],
    [0.28, 0.53, 0.72, 0.58],
    [0.36, 0.68, 0.64, 0.75],
  ].map(([a, b, c, d]) => [px(512 * a), px(512 * b), px(512 * c), px(512 * d)]);

  const at = (x, y) => {
    const insidePanel = x >= x0 && x < x1 && y >= y0 && y < bodyBottom;
    if (!insidePanel) {
      // torn foot: alternating tabs hanging below the panel's straight edge
      if (y >= bodyBottom && y < y1 && x >= x0 && x < x1) {
        return (x - x0) % (tabWidth * 2) < tabWidth ? PAPER : SURFACE;
      }
      return SURFACE;
    }
    for (const [lx0, ly0, lx1, ly1] of lines) {
      if (x >= lx0 && x < lx1 && y >= ly0 && y < ly1) return INK;
    }
    return PAPER;
  };

  const stride = size * 3;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter type "none" per scanline: deterministic, and cheap to encode
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = at(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return raw;
};

/** One icon as PNG bytes. RGB truecolour, no alpha, so no compositing surprises in a launcher. */
export function renderIconPng(size, { maskable = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(draw(size, { inset: maskable ? 0.2 : 0.08 }), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The three tiles W11 pins, keyed by the `dist/app` path the precache manifest will name. */
export function appIcons() {
  return [
    { file: "icons/receipt-lens-192.png", png: renderIconPng(192) },
    { file: "icons/receipt-lens-512.png", png: renderIconPng(512) },
    { file: "icons/receipt-lens-512-maskable.png", png: renderIconPng(512, { maskable: true }) },
  ];
}

/** Walk a PNG's chunks into `[type, data]` pairs, so a reader can check what was written rather than trust it. */
export function readPngChunks(png) {
  const out = [];
  let at = 8;
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString("latin1");
    out.push([type, png.subarray(at + 8, at + 8 + length)]);
    at += 12 + length;
  }
  return out;
}

/** Decode back to scanlines. `verify:icons` uses it to prove the encoder round-trips and the size is real. */
export function decodeIconPng(png) {
  const chunks = readPngChunks(png);
  const ihdr = chunks.find(([type]) => type === "IHDR")?.[1];
  const idat = chunks.find(([type]) => type === "IDAT")?.[1];
  if (!ihdr || !idat) throw new Error("not a PNG this script wrote: missing IHDR or IDAT");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const raw = inflateSync(idat);
  if (raw.length !== height * (width * 3 + 1)) throw new Error(`IDAT is ${raw.length} bytes, expected ${height * (width * 3 + 1)}`);
  return { width, height, raw };
}

if (process.argv[1] && process.argv[1].endsWith("make-icons.mjs")) {
  for (const { file, png } of appIcons()) {
    const { width, height } = decodeIconPng(png);
    process.stdout.write(
      `${file}  ${width}x${height}  ${png.byteLength} B  sha256:${createHash("sha256").update(png).digest("hex").slice(0, 16)}\n`,
    );
  }
  process.stdout.write("icons are emitted into dist/app by packages/pwa/vite.config.ts; nothing binary is committed\n");
}
