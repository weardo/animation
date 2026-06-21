// Tiny deterministic PNG encoder + flat-vector software rasterizer.
//
// PURE / DETERMINISTIC (CLAUDE.md golden rule 1): no Date.now / Math.random anywhere. The encoder
// writes a standard RGBA8 PNG (color type 6) via zlib.deflate at a FIXED level so the byte output is
// reproducible across runs/machines. The rasterizer draws only flat-color primitives (filled
// circles, ellipses, rounded rects, with optional anti-aliased edges + a flat outline) — exactly the
// Kurzgesagt flat-vector look: solid fills, crisp shapes, no gradients baked into the atlas (shading
// is composited at render time per spec §11.1, not painted into the art).
//
// This is OFFLINE asset generation (CLAUDE.md golden rule 2: AI/codegen only touches the offline
// library, never frames/runtime). The atlas it emits is a fixed identity asset.

import { deflateSync } from 'node:zlib';

// ---- CRC32 (PNG chunk checksums) ----
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

/** A simple RGBA8 raster surface with flat-vector fill primitives. */
export class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    // RGBA, premult-free, transparent background.
    this.data = new Uint8Array(width * height * 4);
  }

  // Blend src (with alpha 0..1) over the existing pixel (standard source-over).
  _blend(x, y, r, g, b, a) {
    if (a <= 0) return;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const dstA = this.data[i + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA <= 0) return;
    const blend = (s, d) => (s * a + d * (dstA * (1 - a))) / outA;
    this.data[i] = Math.round(blend(r, this.data[i]));
    this.data[i + 1] = Math.round(blend(g, this.data[i + 1]));
    this.data[i + 2] = Math.round(blend(b, this.data[i + 2]));
    this.data[i + 3] = Math.round(outA * 255);
  }

  // Coverage of pixel (px,py) inside an SDF-defined shape, supersampled 3x3 for an AA edge.
  _coverage(px, py, sdf) {
    let hits = 0;
    const N = 3;
    for (let sy = 0; sy < N; sy++) {
      for (let sx = 0; sx < N; sx++) {
        const x = px + (sx + 0.5) / N;
        const y = py + (sy + 0.5) / N;
        if (sdf(x, y) <= 0) hits++;
      }
    }
    return hits / (N * N);
  }

  /** Fill an arbitrary shape given a signed-distance test (<=0 inside). color = [r,g,b], alpha 0..1. */
  fillSDF(sdf, bbox, color, alpha = 1) {
    const [x0, y0, x1, y1] = bbox;
    const minX = Math.max(0, Math.floor(x0));
    const minY = Math.max(0, Math.floor(y0));
    const maxX = Math.min(this.width - 1, Math.ceil(x1));
    const maxY = Math.min(this.height - 1, Math.ceil(y1));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const cov = this._coverage(x, y, sdf);
        if (cov > 0) this._blend(x, y, color[0], color[1], color[2], alpha * cov);
      }
    }
  }

  fillCircle(cx, cy, r, color, alpha = 1) {
    const sdf = (x, y) => Math.hypot(x - cx, y - cy) - r;
    this.fillSDF(sdf, [cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1], color, alpha);
  }

  fillEllipse(cx, cy, rx, ry, color, alpha = 1) {
    const sdf = (x, y) => {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      // approximate signed distance of an ellipse (good enough for AA at this scale)
      return (Math.hypot(dx, dy) - 1) * Math.min(rx, ry);
    };
    this.fillSDF(sdf, [cx - rx - 1, cy - ry - 1, cx + rx + 1, cy + ry + 1], color, alpha);
  }

  fillRoundRect(x, y, w, h, rad, color, alpha = 1) {
    const sdf = (px, py) => {
      const hw = w / 2;
      const hh = h / 2;
      const cx = x + hw;
      const cy = y + hh;
      const qx = Math.abs(px - cx) - (hw - rad);
      const qy = Math.abs(py - cy) - (hh - rad);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - rad;
    };
    this.fillSDF(sdf, [x - 1, y - 1, x + w + 1, y + h + 1], color, alpha);
  }

  /** Stroke a rounded rect outline (flat ink line) by filling the SDF band [−t, 0]. */
  strokeRoundRect(x, y, w, h, rad, t, color, alpha = 1) {
    const base = (px, py) => {
      const hw = w / 2;
      const hh = h / 2;
      const cx = x + hw;
      const cy = y + hh;
      const qx = Math.abs(px - cx) - (hw - rad);
      const qy = Math.abs(py - cy) - (hh - rad);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - rad;
    };
    const sdf = (px, py) => Math.abs(base(px, py) + t / 2) - t / 2;
    this.fillSDF(sdf, [x - t - 1, y - t - 1, x + w + t + 1, y + h + t + 1], color, alpha);
  }
}

/** Encode a Canvas to PNG bytes (RGBA8, deterministic). */
export function encodePNG(canvas) {
  const { width, height, data } = canvas;
  // Raw image data with a filter byte (0 = none) per scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  // Fixed deflate level => deterministic compressed bytes.
  const compressed = deflateSync(raw, { level: 9 });

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Parse a #rrggbb hex string to [r,g,b]. */
export function hex(c) {
  const h = c.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
