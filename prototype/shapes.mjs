// Procedural Kurzgesagt-style ASSET FACTORY — prototype.
// Proves: living beings/objects built ENTIRELY from code-generated primitive shapes (no vendor
// rigs, no AI frames), layered + arranged, animated as a pure function of (seed, frame).
// Run: node prototype/shapes.mjs  → writes prototype/preview.html (a 3-objects × 3-frames grid).
//
// Everything here is deterministic: a seeded PRNG + frame-driven trig/noise. No Date.now/Math.random.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

// ---------- deterministic primitives ----------
const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// smooth periodic pseudo-noise (deterministic), good for organic wobble
function noise(t, seed = 0) {
  return (
    0.6 * Math.sin(t + seed * 1.7) +
    0.3 * Math.sin(t * 2.3 + seed * 3.1) +
    0.1 * Math.sin(t * 4.7 + seed * 5.9)
  ) / (0.6 + 0.3 + 0.1);
}

let _uid = 0;
const uid = (p) => `${p}${_uid++}`;

// ---------- palette (Kurzgesagt: saturated shapes on deep indigo, with glow) ----------
const C = {
  bg0: '#241a4a', bg1: '#140d2e',
  star: ['#fff7d6', '#ffd23f', '#ff8c42', '#ff5d3a'],
  cellMembrane: ['#3fe0c5', '#1f9e8e'], cellRim: '#7afoe0',
  nucleus: ['#9b6cff', '#5b2bb5'],
  organelle: ['#ff5d8f', '#ffd23f', '#4cc9f0', '#ff8c42', '#b1f25a'],
  bird: ['#5cc8ff', '#2a7fd6'], birdBelly: '#d6f0ff', beak: '#ffb23f', cheek: '#ff7eb0',
  ink: '#13203a',
};

// soft radial gradient def + a blurred-glow filter; returns {defs, fillRef, glowRef}
function gradGlow(ns, stops, blur = 6) {
  const gid = uid(ns + '_g');
  const fid = uid(ns + '_f');
  const stopsSvg = stops
    .map(([c, o], i) => `<stop offset="${(i / (stops.length - 1)) * 100}%" stop-color="${c}"/>`) // eslint-disable-line
    .join('');
  const defs =
    `<radialGradient id="${gid}" cx="40%" cy="35%" r="75%">${stopsSvg}</radialGradient>` +
    `<filter id="${fid}" x="-60%" y="-60%" width="220%" height="220%">` +
    `<feGaussianBlur stdDeviation="${blur}"/></filter>`;
  return { defs, fillRef: `url(#${gid})`, glowRef: `url(#${fid})` };
}

// closed smooth blob path (organic), wobbling by frame via noise
function blob(cx, cy, r, { points = 10, amp = 0.12, seed = 1, frame = 0, speed = 0.04 } = {}) {
  const pts = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * TAU;
    const rr = r * (1 + amp * noise(a * 2 + frame * speed, seed));
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  // smooth closed path through points (Catmull-Rom → cubic bezier)
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)} `;
  for (let i = 0; i < points; i++) {
    const p0 = pts[(i - 1 + points) % points];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % points];
    const p3 = pts[(i + 2) % points];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)} `;
  }
  return d + 'Z';
}

// ---------- OBJECT 1: radiating star ----------
function star(frame, ns) {
  const cx = 180, cy = 180;
  const pulse = 1 + 0.06 * Math.sin(frame * 0.12);
  const halo = gradGlow(ns, [['#fff7d6', 1], ['#ffd23f', 1], ['#ff8c4200', 0]], 14);
  const core = gradGlow(ns, [['#ffffff', 1], ['#ffd23f', 1], ['#ff8c42', 1]], 3);
  const rng = mulberry32(7);

  // rays: two interleaved sets, slowly rotating, length pulsing
  let rays = '';
  const N = 12;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU + frame * 0.012;
    const long = i % 2 === 0;
    const len = (long ? 150 : 95) * (1 + 0.10 * Math.sin(frame * 0.15 + i));
    const w = long ? 0.10 : 0.06;
    const x1 = cx + Math.cos(a) * 55, y1 = cy + Math.sin(a) * 55;
    const xt = cx + Math.cos(a) * len, yt = cy + Math.sin(a) * len;
    const xa = cx + Math.cos(a + w) * 60, ya = cy + Math.sin(a + w) * 60;
    const xb = cx + Math.cos(a - w) * 60, yb = cy + Math.sin(a - w) * 60;
    rays += `<path d="M ${xa.toFixed(1)} ${ya.toFixed(1)} L ${xt.toFixed(1)} ${yt.toFixed(1)} L ${xb.toFixed(1)} ${yb.toFixed(1)} Z" fill="${long ? '#ffd23f' : '#ff8c42'}" opacity="0.9"/>`;
  }
  // sparkles around, twinkling
  let sparks = '';
  for (let i = 0; i < 14; i++) {
    const a = rng() * TAU, d = 130 + rng() * 80;
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
    const tw = 0.4 + 0.6 * Math.abs(Math.sin(frame * 0.18 + i * 1.3));
    const s = 2 + rng() * 3;
    sparks += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(s * tw).toFixed(2)}" fill="#fff7d6" opacity="${tw.toFixed(2)}"/>`;
  }
  return `<svg viewBox="0 0 360 360" width="360" height="360"><defs>${halo.defs}${core.defs}</defs>
    <circle cx="${cx}" cy="${cy}" r="${(120 * pulse).toFixed(1)}" fill="${halo.fillRef}" filter="${halo.glowRef}" opacity="0.85"/>
    <g transform="translate(${cx} ${cy}) scale(${pulse.toFixed(3)}) translate(${-cx} ${-cy})">${rays}</g>
    <circle cx="${cx}" cy="${cy}" r="46" fill="${core.fillRef}" filter="${core.glowRef}"/>
    <circle cx="${cx}" cy="${cy}" r="40" fill="${core.fillRef}"/>
    ${sparks}</svg>`;
}

// ---------- OBJECT 2: living cell (hundreds of tiny shapes) ----------
function cell(frame, ns) {
  const cx = 180, cy = 180;
  const mem = gradGlow(ns, [['#5cf2d9', 0.55], ['#2ec4b6', 0.4], ['#1f7e74', 0.25]], 4);
  const nuc = gradGlow(ns, [['#b69bff', 1], ['#7b4fe0', 1], ['#4a219e', 1]], 3);
  const memPath = blob(cx, cy, 150, { points: 12, amp: 0.05, seed: 2, frame, speed: 0.05 });
  const nucPath = blob(cx, cy + 8, 58, { points: 9, amp: 0.06, seed: 5, frame, speed: 0.06 });

  // ribosomes: HUNDREDS of tiny dots scattered inside the membrane, gently drifting
  const rng = mulberry32(42);
  let dots = '';
  let count = 0;
  for (let i = 0; i < 260; i++) {
    const a = rng() * TAU, d = Math.sqrt(rng()) * 132;
    let x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
    x += Math.sin(frame * 0.05 + i) * 1.5; y += Math.cos(frame * 0.045 + i * 1.3) * 1.5;
    const col = C.organelle[i % C.organelle.length];
    const r = 1.4 + rng() * 1.8;
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="${col}" opacity="0.7"/>`;
    count++;
  }
  // organelles: mitochondria (capsules with inner squiggle) drifting
  let org = '';
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + frame * 0.01, d = 78;
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
    const rot = (a * 180) / Math.PI + 90 * Math.sin(frame * 0.03 + i);
    const col = C.organelle[i % C.organelle.length];
    org += `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)})">
      <rect x="-16" y="-9" width="32" height="18" rx="9" fill="${col}" opacity="0.92"/>
      <path d="M -12 0 Q -6 -6 0 0 T 12 0" stroke="#ffffff" stroke-width="1.6" fill="none" opacity="0.7"/>
    </g>`;
  }
  return `<svg viewBox="0 0 360 360" width="360" height="360"><defs>${mem.defs}${nuc.defs}</defs>
    <path d="${memPath}" fill="${mem.fillRef}" stroke="#7af0e0" stroke-width="3" stroke-opacity="0.6"/>
    <clipPath id="${ns}clip"><path d="${memPath}"/></clipPath>
    <g clip-path="url(#${ns}clip)">${dots}${org}
      <path d="${nucPath}" fill="${nuc.fillRef}" stroke="#c9b3ff" stroke-width="2" stroke-opacity="0.5"/>
      <circle cx="${cx + 10}" cy="${cy + 2}" r="12" fill="#3a1f7e" opacity="0.8"/>
    </g></svg>`;
}

// ---------- OBJECT 3: birb ----------
function bird(frame, ns) {
  const cx = 180, baseY = 195;
  const bob = Math.sin(frame * 0.13) * 7;
  const cy = baseY + bob;
  const body = gradGlow(ns, [['#7ad4ff', 1], ['#4aa8f0', 1], ['#2a7fd6', 1]], 3);
  const flap = Math.sin(frame * 0.35) * 18; // wing rotation
  const blink = Math.abs(Math.sin(frame * 0.07)) > 0.96 ? 0.15 : 1; // occasional blink (eye scaleY)
  const squash = 1 + 0.03 * Math.sin(frame * 0.13 + 1.5);

  const bodyPath = blob(cx, cy, 86, { points: 10, amp: 0.04, seed: 9, frame, speed: 0.04 });
  return `<svg viewBox="0 0 360 360" width="360" height="360"><defs>${body.defs}</defs>
    <g transform="translate(${cx} ${cy}) scale(1 ${squash.toFixed(3)}) translate(${-cx} ${-cy})">
      <!-- shadow -->
      <ellipse cx="${cx}" cy="285" rx="${(70 - bob * 0.4).toFixed(1)}" ry="12" fill="#000000" opacity="0.18"/>
      <!-- back wing -->
      <g transform="rotate(${(-flap).toFixed(1)} ${cx - 50} ${cy - 10})"><path d="${blob(cx - 58, cy + 4, 30, { points: 7, amp: 0.06, seed: 3 })}" fill="#2a7fd6"/></g>
      <!-- body -->
      <path d="${bodyPath}" fill="${body.fillRef}"/>
      <!-- belly -->
      <path d="${blob(cx + 4, cy + 26, 50, { points: 8, amp: 0.05, seed: 4 })}" fill="${C.birdBelly}" opacity="0.85"/>
      <!-- cheeks -->
      <circle cx="${cx - 30}" cy="${cy + 2}" r="11" fill="${C.cheek}" opacity="0.55"/>
      <circle cx="${cx + 36}" cy="${cy + 2}" r="11" fill="${C.cheek}" opacity="0.55"/>
      <!-- eyes -->
      <g transform="translate(${cx - 22} ${cy - 18}) scale(1 ${blink})"><circle r="13" fill="#fff"/><circle cx="2" r="6.5" fill="${C.ink}"/><circle cx="-1.5" cy="-2.5" r="2.4" fill="#fff"/></g>
      <g transform="translate(${cx + 22} ${cy - 18}) scale(1 ${blink})"><circle r="13" fill="#fff"/><circle cx="2" r="6.5" fill="${C.ink}"/><circle cx="-1.5" cy="-2.5" r="2.4" fill="#fff"/></g>
      <!-- beak -->
      <path d="M ${cx - 9} ${cy + 2} L ${cx + 9} ${cy + 2} L ${cx} ${cy + 16} Z" fill="${C.beak}"/>
      <!-- front wing (flaps) -->
      <g transform="rotate(${flap.toFixed(1)} ${cx + 50} ${cy - 10})"><path d="${blob(cx + 58, cy + 4, 32, { points: 7, amp: 0.06, seed: 6 })}" fill="#3a93e8"/></g>
      <!-- feet -->
      <path d="M ${cx - 16} ${cy + 80} l 0 14 m -8 0 h 16" stroke="${C.beak}" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M ${cx + 16} ${cy + 80} l 0 14 m -8 0 h 16" stroke="${C.beak}" stroke-width="4" fill="none" stroke-linecap="round"/>
    </g></svg>`;
}

// ---------- compose preview grid (3 objects × 3 frames) ----------
const objects = [
  ['Radiating star', star],
  ['Living cell (~270 shapes)', cell],
  ['Birb', bird],
];
const frames = [0, 24, 48];

let rows = '';
for (const [name, fn] of objects) {
  let cells = `<div class="label">${name}</div>`;
  for (const f of frames) cells += `<div class="cell">${fn(f, uid('o'))}<span>f${f}</span></div>`;
  rows += `<div class="row">${cells}</div>`;
}

const html = `<!doctype html><meta charset="utf8"><style>
  body{margin:0;background:radial-gradient(circle at 50% 30%, ${C.bg0}, ${C.bg1});font-family:system-ui;color:#cdd}
  .wrap{padding:24px}
  h1{font-weight:700;font-size:20px;margin:4px 0 18px;color:#fff}
  .row{display:grid;grid-template-columns:230px repeat(3,360px);align-items:center;gap:6px}
  .label{font-size:15px;color:#aeb6d8;padding-right:14px}
  .cell{position:relative}
  .cell span{position:absolute;left:10px;bottom:8px;font-size:11px;color:#8a93b8}
</style><div class="wrap"><h1>Procedural Kurzgesagt asset factory — code-only, animated (3 frames each)</h1>${rows}</div>`;

writeFileSync(resolve(ROOT, 'preview.html'), html);
console.log('wrote', resolve(ROOT, 'preview.html'));

// ---- also emit ONE combined SVG (rasterizable via rsvg-convert, no browser needed) ----
const CW = 360, LAB = 230, PAD = 12, HEAD = 60;
const W = LAB + 3 * CW + PAD * 2;
const H = HEAD + 3 * CW + PAD;
let grid = '';
let ry = HEAD;
for (const [name, fn] of objects) {
  grid += `<text x="20" y="${ry + CW / 2}" fill="#aeb6d8" font-family="system-ui" font-size="16">${name}</text>`;
  let rx = LAB;
  for (const f of frames) {
    grid += `<g transform="translate(${rx} ${ry})">${fn(f, uid('o'))}<text x="12" y="${CW - 12}" fill="#8a93b8" font-size="12" font-family="system-ui">f${f}</text></g>`;
    rx += CW;
  }
  ry += CW;
}
const combined = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><radialGradient id="bgrad" cx="50%" cy="28%" r="80%"><stop offset="0%" stop-color="${C.bg0}"/><stop offset="100%" stop-color="${C.bg1}"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bgrad)"/>
<text x="20" y="36" fill="#ffffff" font-family="system-ui" font-size="20" font-weight="700">Procedural Kurzgesagt asset factory — code-only, animated (3 frames each)</text>
${grid}</svg>`;
writeFileSync(resolve(ROOT, 'preview.svg'), combined);
console.log('wrote', resolve(ROOT, 'preview.svg'));

// ---- animation mode: `node prototype/shapes.mjs anim` → N per-frame scene SVGs (→ GIF/strip) ----
if (process.argv[2] === 'anim') {
  const dir = resolve(ROOT, 'frames');
  mkdirSync(dir, { recursive: true });
  const N = 48, cw = 360, w = 3 * cw, h = cw;
  for (let f = 0; f < N; f++) {
    const scene = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><radialGradient id="bg" cx="50%" cy="35%" r="80%"><stop offset="0%" stop-color="${C.bg0}"/><stop offset="100%" stop-color="${C.bg1}"/></radialGradient></defs>
<rect width="${w}" height="${h}" fill="url(#bg)"/>
<g transform="translate(0 0)">${star(f, uid('a'))}</g>
<g transform="translate(${cw} 0)">${cell(f, uid('a'))}</g>
<g transform="translate(${2 * cw} 0)">${bird(f, uid('a'))}</g></svg>`;
    writeFileSync(resolve(dir, `f${String(f).padStart(3, '0')}.svg`), scene);
  }
  console.log('wrote', N, 'frame SVGs to', dir);
}
