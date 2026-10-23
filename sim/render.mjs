// Server-side rendering of the planner's two images, with no browser and no
// native dependencies: a tiny RGB rasteriser plus a PNG encoder on node:zlib.
//
//   renderMap(ep)    charted top-down map: buildings, no-fly zones, home pad,
//                    the drone and its trail. Crates and other pads are NOT
//                    drawn - they are not on the chart.
//   renderCamera(ep) the downward camera: what is actually below the drone,
//                    scaled by altitude, dimmed / noised by the suite.

import zlib from "node:zlib";
import { ARENA, rectDist, footprint, PAD_R, CRATE_SIZE } from "./world.mjs";
import { makeRng } from "./rng.mjs";

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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePNG(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const COLORS = {
  floor: [226, 220, 204], grid: [205, 198, 180],
  red: [220, 38, 38], blue: [37, 99, 235], yellow: [234, 179, 8], green: [22, 163, 74],
  orange: [249, 115, 22], purple: [147, 51, 234], home: [250, 250, 250],
  nfz: [239, 68, 68], drone: [15, 23, 42], trail: [14, 116, 144], scan: [14, 116, 144]
};

function buildingColor(h) {
  const k = Math.max(0, Math.min(1, (h - 3) / 8));
  const v = Math.round(150 - 80 * k);
  return [v, v + 6, v + 16];
}

class Raster {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.data = new Uint8Array(w * h * 3);
  }
  set(x, y, c, alpha = 1) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    for (let k = 0; k < 3; k++) this.data[i + k] = Math.round(this.data[i + k] * (1 - alpha) + c[k] * alpha);
  }
  fill(c) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, c); }
  rect(x0, y0, x1, y1, c, alpha = 1) {
    for (let y = Math.max(0, Math.floor(Math.min(y0, y1))); y <= Math.min(this.h - 1, Math.ceil(Math.max(y0, y1))); y++)
      for (let x = Math.max(0, Math.floor(Math.min(x0, x1))); x <= Math.min(this.w - 1, Math.ceil(Math.max(x0, x1))); x++) this.set(x, y, c, alpha);
  }
  disc(cx, cy, r, c, alpha = 1, inner = -1) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r && d >= inner) this.set(x, y, c, alpha);
      }
  }
  line(x0, y0, x1, y1, c, width = 1) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
      if (width <= 1) this.set(x, y, c); else this.disc(x, y, width / 2, c);
    }
  }
  png() { return encodePNG(this.w, this.h, this.data); }
}

export function renderMap(ep, size = 480) {
  const world = ep.world, f = ep.flight;
  const s = size / (2 * ARENA);
  const px = (x) => (x + ARENA) * s;
  const py = (y) => (ARENA - y) * s;       // world +y is image up
  const R = new Raster(size, size);
  R.fill(COLORS.floor);
  for (let g = -ARENA; g <= ARENA; g += 2) {
    R.line(px(g), 0, px(g), size, COLORS.grid);
    R.line(0, py(g), size, py(g), COLORS.grid);
  }
  for (const z of world.noFly) {
    R.disc(px(z.x), py(z.y), z.r * s, COLORS.nfz, 0.28);
    R.disc(px(z.x), py(z.y), z.r * s, COLORS.nfz, 1, z.r * s - 2);
  }
  for (const b of world.buildings) R.rect(px(b.x - b.w / 2), py(b.y + b.d / 2), px(b.x + b.w / 2), py(b.y - b.d / 2), buildingColor(b.h));
  R.disc(px(world.home.x), py(world.home.y), PAD_R * s, COLORS.home);
  R.disc(px(world.home.x), py(world.home.y), PAD_R * s, COLORS.drone, 1, PAD_R * s - 1.5);
  const trail = f.trail;
  for (let i = 1; i < trail.length; i++) R.line(px(trail[i - 1].x), py(trail[i - 1].y), px(trail[i].x), py(trail[i].y), COLORS.trail);
  if (ep.lastScan) R.disc(px(ep.lastScan.x), py(ep.lastScan.y), ep.lastScan.footprint * s, COLORS.scan, 0.12);
  const dx = px(f.p.x), dy = py(f.p.y);
  R.disc(dx, dy, 6, COLORS.drone);
  R.line(dx, dy, dx + 11 * Math.cos(f.yaw), dy - 11 * Math.sin(f.yaw), COLORS.drone, 2);
  return R.png();
}

export function renderCamera(ep, size = 320) {
  const world = ep.world, f = ep.flight;
  const sensor = world.sensor;
  const half = footprint(Math.max(0.3, f.p.z));   // metres from centre to edge
  const m = (2 * half) / size;                      // metres per pixel
  const R = new Raster(size, size);
  const things = [
    ...world.pads.map((p) => ({ ...p, kind: "pad" })),
    ...world.crates.map((c) => ({ ...c, kind: "crate" }))
  ];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = f.p.x - half + (i + 0.5) * m;
      const y = f.p.y + half - (j + 0.5) * m;
      let c = COLORS.floor, top = 0;
      if (Math.abs(x) > ARENA || Math.abs(y) > ARENA) c = [90, 90, 90];
      else if (Math.abs(((x % 2) + 2) % 2) < m || Math.abs(((y % 2) + 2) % 2) < m) c = COLORS.grid;
      for (const b of world.buildings) {
        if (b.h <= top || rectDist(x, y, b) !== 0) continue;
        // A building at or above the drone fills that part of the view.
        if (b.h >= f.p.z) { c = [52, 58, 72]; top = Infinity; } else { c = buildingColor(b.h); top = b.h; }
      }
      for (const o of things) {
        if (o.z < top - 0.01 || o.z > f.p.z) continue;
        if (o.kind === "pad") {
          const d = Math.hypot(x - o.x, y - o.y);
          if (d < PAD_R) c = d > PAD_R - 0.12 ? [40, 40, 40] : COLORS[o.color];
        } else if (Math.abs(x - o.x) < CRATE_SIZE / 2 && Math.abs(y - o.y) < CRATE_SIZE / 2) {
          c = COLORS[o.color];
        }
      }
      R.set(i, j, c);
    }
  }
  // Reticle at the image centre (directly below the drone).
  const ctr = size / 2;
  R.line(ctr - 8, ctr, ctr + 8, ctr, [15, 23, 42]);
  R.line(ctr, ctr - 8, ctr, ctr + 8, [15, 23, 42]);
  const inspectR = 1.5 / m;
  R.disc(ctr, ctr, inspectR, [15, 23, 42], 0.6, inspectR - 1);
  if (sensor.light < 1 || sensor.scanNoise > 1) {
    const rng = makeRng("pixels", world.init, f.steps);
    const amp = sensor.scanNoise > 1 ? 28 : 6;
    for (let k = 0; k < R.data.length; k++) {
      const v = R.data[k] * sensor.light + amp * rng.normal();
      R.data[k] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return R.png();
}
