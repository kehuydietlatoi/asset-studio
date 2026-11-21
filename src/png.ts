/** Small pure-JS image helpers (RGBA, 8 bit) on top of pngjs. No native dependencies. */
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

export interface Img {
  width: number;
  height: number;
  data: Buffer; // RGBA
}

export function readPng(path: string): Img {
  const p = PNG.sync.read(readFileSync(path));
  return { width: p.width, height: p.height, data: p.data };
}

export function writePng(path: string, img: Img): void {
  const p = new PNG({ width: img.width, height: img.height });
  img.data.copy(p.data);
  writeFileSync(path, PNG.sync.write(p));
}

export function blank(width: number, height: number): Img {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

/** Bilinear resize (straight alpha; good enough for downscales of art and for masks). */
export function resize(src: Img, width: number, height: number): Img {
  if (src.width === width && src.height === height) return { width, height, data: Buffer.from(src.data) };
  const out = blank(width, height);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(src.height - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(src.width - 1, x0 + 1), wx = fx - x0;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = src.data[(y0 * src.width + x0) * 4 + c], b = src.data[(y0 * src.width + x1) * 4 + c];
        const d = src.data[(y1 * src.width + x0) * 4 + c], e = src.data[(y1 * src.width + x1) * 4 + c];
        out.data[o + c] = Math.round((a * (1 - wx) + b * wx) * (1 - wy) + (d * (1 - wx) + e * wx) * wy);
      }
    }
  }
  return out;
}

/** Put the image on an opaque background colour (what the image model sees). */
export function flatten(src: Img, rgb: [number, number, number]): Img {
  const out = blank(src.width, src.height);
  for (let i = 0; i < src.data.length; i += 4) {
    const a = src.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(src.data[i + c] * a + rgb[c] * (1 - a));
    out.data[i + 3] = 255;
  }
  return out;
}

/**
 * Key out a flat background colour. Pixels within `tol` of the key become transparent; pixels up to 2*tol
 * get partial alpha and have the key colour unmixed from them (removes the pink fringe).
 */
export function keyOut(src: Img, rgb: [number, number, number], tol = 60): Img {
  const out = blank(src.width, src.height);
  for (let i = 0; i < src.data.length; i += 4) {
    const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2];
    const d = Math.hypot(r - rgb[0], g - rgb[1], b - rgb[2]);
    let a = d <= tol ? 0 : d >= tol * 2 ? 1 : (d - tol) / tol;
    a *= src.data[i + 3] / 255;
    if (a > 0) {
      for (let c = 0; c < 3; c++) {
        const v = (src.data[i + c] - (1 - a) * rgb[c]) / a;
        out.data[i + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
    out.data[i + 3] = Math.round(a * 255);
  }
  return out;
}

/** Mask (0..1) from a PNG: white/opaque = change. Resized to width x height. */
export function maskFrom(src: Img, width: number, height: number): Float32Array {
  const m = resize(src, width, height);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = ((m.data[p] + m.data[p + 1] + m.data[p + 2]) / 765) * (m.data[p + 3] / 255);
  }
  return out;
}

/** Grow the mask by `grow` px and soften its edge over `feather` px (box blurs). */
export function softenMask(mask: Float32Array, width: number, height: number, grow: number, feather: number): Float32Array {
  let m = mask;
  if (grow > 0) m = threshold(boxBlur(m, width, height, grow), 1e-4);
  if (feather > 0) m = boxBlur(boxBlur(m, width, height, feather), width, height, feather);
  return m;
}

function threshold(m: Float32Array, t: number): Float32Array {
  const o = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) o[i] = m[i] > t ? 1 : 0;
  return o;
}

function boxBlur(m: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(m.length);
  const out = new Float32Array(m.length);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += m[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / (2 * r + 1);
      s += m[y * w + Math.min(w - 1, x + r + 1)] - m[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** out = base where mask=0, top where mask=1, blended between. Same size required. */
export function composite(base: Img, top: Img, mask: Float32Array): Img {
  if (base.width !== top.width || base.height !== top.height) throw new Error("composite: size mismatch");
  const out = blank(base.width, base.height);
  for (let i = 0; i < mask.length; i++) {
    const m = Math.max(0, Math.min(1, mask[i]));
    const p = i * 4;
    const ab = base.data[p + 3] / 255, at = top.data[p + 3] / 255;
    const a = ab * (1 - m) + at * m;
    for (let c = 0; c < 3; c++) {
      const v = a > 0 ? (base.data[p + c] * ab * (1 - m) + top.data[p + c] * at * m) / a : 0;
      out.data[p + c] = Math.round(v);
    }
    out.data[p + 3] = Math.round(a * 255);
  }
  return out;
}

/** Copy of the rectangle (x, y, w, h); parts outside the image stay transparent. */
export function crop(src: Img, x: number, y: number, w: number, h: number): Img {
  const out = blank(w, h);
  for (let yy = 0; yy < h; yy++) {
    const sy = y + yy;
    if (sy < 0 || sy >= src.height) continue;
    for (let xx = 0; xx < w; xx++) {
      const sx = x + xx;
      if (sx < 0 || sx >= src.width) continue;
      src.data.copy(out.data, (yy * w + xx) * 4, (sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4);
    }
  }
  return out;
}

/** True when visible pixels (alpha > 32) lie within `margin` px of the image edge: the piece may be cut off. */
export function touchesEdge(img: Img, margin = 2): boolean {
  const { width: w, height: h, data } = img;
  for (let y = 0; y < h; y++) {
    const edgeRow = y < margin || y >= h - margin;
    for (let x = 0; x < w; x++) {
      if (!edgeRow && x >= margin && x < w - margin) {
        x = w - margin - 1; // skip the inside of the row
        continue;
      }
      if (data[(y * w + x) * 4 + 3] > 32) return true;
    }
  }
  return false;
}

/** True when the image has no visible pixel at all (an empty variant cell). */
export function isEmpty(img: Img): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 32) return false;
  return true;
}

/** Fraction of mask pixels that are set (> 0.5). */
export function maskCoverage(mask: Float32Array): number {
  let n = 0;
  for (const v of mask) if (v > 0.5) n++;
  return n / mask.length;
}
