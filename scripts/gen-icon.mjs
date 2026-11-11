// Deterministic marketplace icon generator — no image libraries needed.
// Renders at 4x into an RGBA buffer, box-downsamples to 128x128 and encodes a
// PNG with Node's built-in zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = 128;
const SS = 4;
const SIZE = OUT * SS;
const px = new Float64Array(SIZE * SIZE * 4);

function put(x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
}

function fill(test, color) {
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (test(x + 0.5, y + 0.5)) put(x, y, color);
}

const roundedRect = (x0, y0, w, h, r) => (x, y) => {
  const dx = Math.max(x0 + r - x, x - (x0 + w - r), 0);
  const dy = Math.max(y0 + r - y, y - (y0 + h - r), 0);
  return x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h && Math.hypot(dx, dy) <= r;
};
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) <= r;
const ring = (cx, cy, r, w) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) <= w / 2;
const segment = (x1, y1, x2, y2, w) => (x, y) => {
  const vx = x2 - x1, vy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(x - (x1 + t * vx), y - (y1 + t * vy)) <= w / 2;
};

const S = (v) => v * SS; // design units are 128-px coordinates
const BG_TOP = [14, 74, 110];
const BG_BOTTOM = [9, 42, 66];
const WHITE = [255, 255, 255];
const GREEN = [46, 204, 113];

// background with vertical gradient
const bg = roundedRect(S(4), S(4), S(120), S(120), S(26));
for (let y = 0; y < SIZE; y++) {
  const t = y / SIZE;
  const c = BG_TOP.map((v, k) => v + (BG_BOTTOM[k] - v) * t);
  for (let x = 0; x < SIZE; x++) if (bg(x + 0.5, y + 0.5)) put(x, y, c);
}

// universal access figure inside a ring
fill(ring(S(58), S(60), S(40), S(6)), WHITE);
fill(circle(S(58), S(35), S(7.5)), WHITE);
fill(segment(S(34), S(48), S(82), S(48), S(7)), WHITE); // arms
fill(segment(S(58), S(48), S(58), S(68), S(9)), WHITE); // torso
fill(segment(S(58), S(66), S(47), S(88), S(7)), WHITE); // left leg
fill(segment(S(58), S(66), S(69), S(88), S(7)), WHITE); // right leg

// check badge
fill(circle(S(96), S(96), S(19)), BG_BOTTOM);
fill(circle(S(96), S(96), S(15.5)), GREEN);
fill(segment(S(88), S(96.5), S(93.5), S(102), S(5)), WHITE);
fill(segment(S(93.5), S(102), S(104), S(90.5), S(5)), WHITE);

// downsample
const out = new Uint8Array(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * SIZE + (x * SS + sx)) * 4;
        const al = px[i + 3] / 255;
        r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += px[i + 3];
      }
    }
    const n = SS * SS;
    const alpha = a / n;
    const o = (y * OUT + x) * 4;
    const w = alpha > 0 ? (255 / alpha) / n : 0;
    out[o] = Math.round(r * w); out[o + 1] = Math.round(g * w); out[o + 2] = Math.round(b * w);
    out[o + 3] = Math.round(alpha);
  }
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const raw = Buffer.alloc(OUT * (OUT * 4 + 1));
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0;
  Buffer.from(out.buffer, y * OUT * 4, OUT * 4).copy(raw, y * (OUT * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(join(here, '..', 'media', 'icon.png'));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, png);
process.stdout.write(`icon written: ${target} (${png.length} bytes)\n`);
