// Generates PNG assets (tray + app icon) with zero binary dependencies.
// Pure-Node PNG encoder so the repo needs no checked-in binaries.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- tiny PNG encoder (8-bit RGBA) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- tiny drawing helpers ----
function canvas(w, h) { return { w, h, data: Buffer.alloc(w * h * 4) }; }
function px(c, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  const sa = a / 255;
  const da = c.data[i + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) { c.data[i] = c.data[i + 1] = c.data[i + 2] = c.data[i + 3] = 0; return; }
  c.data[i] = Math.round((r * sa + c.data[i] * da * (1 - sa)) / outA);
  c.data[i + 1] = Math.round((g * sa + c.data[i + 1] * da * (1 - sa)) / outA);
  c.data[i + 2] = Math.round((b * sa + c.data[i + 2] * da * (1 - sa)) / outA);
  c.data[i + 3] = Math.round(outA * 255);
}
// rounded-rect coverage with 4x supersampled edges
function roundRect(c, x0, y0, w, h, radius, col) {
  const [r, g, b, a] = col;
  const x1 = x0 + w, y1 = y0 + h;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      let cover = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const px_ = x + (sx + 0.5) / 4, py_ = y + (sy + 0.5) / 4;
        if (inRoundRect(px_, py_, x0, y0, x1, y1, radius)) cover++;
      }
      if (cover > 0) px(c, x, y, r, g, b, Math.round(a * cover / 16));
    }
  }
}
function inRoundRect(px_, py_, x0, y0, x1, y1, radius) {
  if (px_ < x0 || py_ < y0 || px_ > x1 || py_ > y1) return false;
  let cx = null, cy = null;
  if (px_ < x0 + radius && py_ < y0 + radius) { cx = x0 + radius; cy = y0 + radius; }
  else if (px_ > x1 - radius && py_ < y0 + radius) { cx = x1 - radius; cy = y0 + radius; }
  else if (px_ < x0 + radius && py_ > y1 - radius) { cx = x0 + radius; cy = y1 - radius; }
  else if (px_ > x1 - radius && py_ > y1 - radius) { cx = x1 - radius; cy = y1 - radius; }
  if (cx === null) return true;
  const dx = px_ - cx, dy = py_ - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function drawIcon(size) {
  const c = canvas(size, size);
  const s = size / 256;
  // outer panel (dark glass)
  const pad = 18 * s;
  roundRect(c, pad, pad, size - pad * 2, size - pad * 2, 48 * s, [22, 26, 36, 255]);
  roundRect(c, pad, pad, size - pad * 2, size - pad * 2, 48 * s, [255, 255, 255, 14]); // faint top sheen overlay-ish
  // two accent "section" cards
  const gx = pad + 26 * s;
  const cw = size - pad * 2 - 52 * s;
  roundRect(c, gx, pad + 34 * s, cw, 58 * s, 16 * s, [110, 168, 254, 255]);
  roundRect(c, gx, pad + 108 * s, cw * 0.62, 58 * s, 16 * s, [126, 231, 196, 235]);
  roundRect(c, gx + cw * 0.66, pad + 108 * s, cw * 0.34, 58 * s, 16 * s, [255, 255, 255, 40]);
  return c;
}

function drawTray(size) {
  const c = canvas(size, size);
  const s = size / 32;
  roundRect(c, 2 * s, 2 * s, 28 * s, 28 * s, 8 * s, [110, 168, 254, 255]);
  roundRect(c, 7 * s, 8 * s, 18 * s, 5 * s, 2.5 * s, [255, 255, 255, 235]);
  roundRect(c, 7 * s, 17 * s, 11 * s, 5 * s, 2.5 * s, [255, 255, 255, 200]);
  return c;
}

function main() {
  const dir = __dirname;
  try {
    const icon = drawIcon(256);
    fs.writeFileSync(path.join(dir, 'icon.png'), encodePng(icon.w, icon.h, icon.data));
    const tray = drawTray(32);
    fs.writeFileSync(path.join(dir, 'tray.png'), encodePng(tray.w, tray.h, tray.data));
    console.log('Icons generated: assets/icon.png, assets/tray.png');
  } catch (e) {
    console.error('Icon generation failed (non-fatal):', e.message);
  }
}
main();
