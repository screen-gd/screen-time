// Generates the app, tray and window icons from the same geometry as the inline SVG mark:
// four tally strokes crossed by a fifth. Pure Node, no image libraries.
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'build');
fs.mkdirSync(OUT, { recursive: true });

const INK = [20, 23, 28];
const PAPER = [255, 255, 255];

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const segDist = (x, y, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1;
  const t = clamp(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
};
const roundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - (hw - r), qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

// The mark: five strokes on a 32-unit grid. Four upright, one rising through them.
const strokes = [
  [9.5, 6.5, 9.5, 25.5],
  [14, 6.5, 14, 25.5],
  [18.5, 6.5, 18.5, 25.5],
  [23, 6.5, 23, 25.5],
  [7.2, 21.6, 24.8, 10.4],
];

function render(size, template = false) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  const scale = size / 32;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let paper = 0, ink = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (x + (sx + 0.5) / ss) / scale;
          const uy = (y + (sy + 0.5) / ss) / scale;
          // Template icons are bare strokes on transparency, no paper square.
          const insidePaper = template || roundRect(ux, uy, 16, 16, 15, 15, 6.2) <= 0;
          if (!insidePaper) continue;
          paper++;
          let insideInk = false;
          for (const [x1, y1, x2, y2] of strokes) {
            if (segDist(ux, uy, x1, y1, x2, y2) <= 1.05) { insideInk = true; break; }
          }
          if (insideInk) ink++;
        }
      }
      const total = ss * ss;
      const a = template ? ink / total : paper / total;
      const inkFrac = !template && paper ? ink / paper : 0;
      const r = template ? 0 : PAPER[0] * (1 - inkFrac) + INK[0] * inkFrac;
      const g = template ? 0 : PAPER[1] * (1 - inkFrac) + INK[1] * inkFrac;
      const b = template ? 0 : PAPER[2] * (1 - inkFrac) + INK[2] * inkFrac;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r); px[i + 1] = Math.round(g); px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, size, px);
}

for (const size of [16, 24, 32]) {
  fs.writeFileSync(path.join(OUT, `tray-${size}.png`), render(size));
}
fs.writeFileSync(path.join(OUT, 'icon.png'), render(256));
// macOS and Linux packaging want at least 512 px; the menu bar wants template
// icons (black strokes, transparent background) it can tint per appearance.
fs.writeFileSync(path.join(OUT, 'icon-1024.png'), render(1024));
fs.writeFileSync(path.join(OUT, 'trayTemplate.png'), render(16, true));
fs.writeFileSync(path.join(OUT, 'trayTemplate@2x.png'), render(32, true));
console.log('Wrote build/icon.png, icon-1024.png, tray icons and macOS template icons.');
