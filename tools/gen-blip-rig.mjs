// gen-blip-rig.mjs — code-generates the "blip" character rig (M2.0). NO editor.
//
// Emits a complete DragonBones v5.5 rig as three files (skeleton + atlas json + atlas png) into BOTH
// library/characters/blip/ (the catalog source of truth) and public/blip/ (Remotion staticFile), a
// flat-vector Kurzgesagt-style blob creature built entirely from primitives.
//
// DETERMINISM (CLAUDE.md r.1): pure code — no Date.now / Math.random. Same script ⇒ byte-identical
// files every run. IDENTITY (r.2): this is offline asset generation; the atlas is a fixed identity
// asset, runtime only transforms it.
//
// WHAT IT BUILDS
//   • Bone hierarchy: root → hip → torso → head, + two jointed arms (armR/foreR, armL/foreL) on the
//     torso, + two jointed legs (legR/shinR, legL/shinL) on the hip; eyes/mouth/brow bones on head.
//   • Slots/skins with attachment swaps: eyeR/eyeL carry eye_open + eye_closed displays (blink);
//     mouth carries mouth_neutral + mouth_open + mouth_smile (viseme-ready, spec §8 lip-sync).
//   • AUTHORED FFD: the body blob is an UNWEIGHTED mesh (the spike-proven simplest path) with a
//     'ffd' deform timeline in the idle + wave clips → real authored mesh deformation (breathe /
//     squash), not bone skinning. Structure mirrors the spike's documented v5.5 `ffd` array.
//   • Clips: idle (loop; gentle breathe via FFD), blink (eye-swap), wave (arm raise + waggle + a
//     squash FFD beat).
//
// All motion keyframes use tweenEasing (curve/non-zero) so nothing is linear (CLAUDE.md r.7); the
// host RigLayer adds StyleKit liveness on top.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Canvas, encodePNG, hex } from './png.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'blip';
const ARMATURE = 'blip';
const VERSION = '5.5';
const FRAME_RATE = 24;

// ----------------------------------------------------------------------------------------------
// Kurzgesagt-style flat palette (matches DEFAULT_PALETTE family in src/render/stylekit.ts).
// ----------------------------------------------------------------------------------------------
const PAL = {
  body: '#4d9fff', // cool blue blob body
  bodyDark: '#3b7fd6', // limb / shade tone
  belly: '#bfe0ff', // light belly patch
  ink: '#0d1b33', // outline / pupils
  white: '#fff6e0', // eye whites / highlight
  beak: '#ffcf4d', // warm beak / feet accent
  mouth: '#243a66', // mouth interior
};

// ----------------------------------------------------------------------------------------------
// ATLAS LAYOUT. Each part is a sub-texture rect (x,y,w,h, name). We draw a flat shape into each
// rect, then DragonBones slices the atlas by name. Power-of-two atlas keeps the GL upload tidy.
// ----------------------------------------------------------------------------------------------
const ATLAS_W = 512;
const ATLAS_H = 512;

// part name -> { x, y, w, h, draw(canvas, rect) }. Rects are hand-packed (no overlap).
const PARTS = {
  // The body blob: a big rounded shape with a belly patch. This is the FFD mesh source.
  body: { x: 8, y: 8, w: 200, h: 210, draw: drawBody },
  head: { x: 220, y: 8, w: 180, h: 170, draw: drawHead },
  // Eyes: open (white + pupil) and closed (a flat ink lash line).
  eye_open: { x: 410, y: 8, w: 70, h: 70, draw: drawEyeOpen },
  eye_closed: { x: 410, y: 86, w: 70, h: 30, draw: drawEyeClosed },
  // Mouth visemes.
  mouth_neutral: { x: 220, y: 186, w: 90, h: 30, draw: drawMouthNeutral },
  mouth_open: { x: 318, y: 186, w: 80, h: 70, draw: drawMouthOpen },
  mouth_smile: { x: 220, y: 224, w: 90, h: 44, draw: drawMouthSmile },
  // Beak / nose accent.
  beak: { x: 410, y: 124, w: 70, h: 56, draw: drawBeak },
  // Limbs (simple capsules) — upper + fore segments share a look.
  upperArm: { x: 8, y: 226, w: 46, h: 96, draw: (c, r) => drawLimb(c, r, PAL.bodyDark) },
  foreArm: { x: 62, y: 226, w: 42, h: 88, draw: (c, r) => drawLimb(c, r, PAL.bodyDark) },
  upperLeg: { x: 112, y: 226, w: 50, h: 92, draw: (c, r) => drawLimb(c, r, PAL.bodyDark) },
  shin: { x: 170, y: 280, w: 44, h: 84, draw: (c, r) => drawLimb(c, r, PAL.bodyDark) },
  hand: { x: 8, y: 330, w: 48, h: 48, draw: drawHand },
  foot: { x: 64, y: 322, w: 64, h: 40, draw: drawFoot },
};

// ----------------------------------------------------------------------------------------------
// SHAPE DRAW FUNCTIONS (flat-vector). Each gets the canvas + its atlas rect.
// ----------------------------------------------------------------------------------------------
// The body mesh grid spans EXACTLY the painted body region (inset by BODY_INSET on each side) so
// every mesh vertex samples opaque body pixels — otherwise the outer mesh ring would sample the
// transparent atlas margin and the FFD deform would reveal hard rectangular seams.
const BODY_INSET = 6;

function drawBody(c, r) {
  const cx = r.x + r.w / 2;
  const x = r.x + BODY_INSET;
  const y = r.y + BODY_INSET;
  const w = r.w - 2 * BODY_INSET;
  const h = r.h - 2 * BODY_INSET;
  const rad = Math.min(w, h) * 0.42;
  // Blobby rounded body, painted to fill the inset region edge-to-edge (ink outline + body fill).
  c.fillRoundRect(x, y, w, h, rad, hex(PAL.ink));
  c.fillRoundRect(x + 4, y + 4, w - 8, h - 8, rad - 4, hex(PAL.body));
  // Belly patch (lighter ellipse low-centre).
  c.fillEllipse(cx, r.y + r.h * 0.62, w * 0.30, h * 0.28, hex(PAL.belly));
}

function drawHead(c, r) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  c.fillEllipse(cx, cy, r.w / 2 - 4, r.h / 2 - 4, hex(PAL.ink));
  c.fillEllipse(cx, cy, r.w / 2 - 8, r.h / 2 - 8, hex(PAL.body));
  // subtle cheek highlight
  c.fillEllipse(cx + r.w * 0.22, cy + r.h * 0.12, r.w * 0.12, r.h * 0.10, hex(PAL.belly), 0.6);
}

function drawEyeOpen(c, r) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  c.fillCircle(cx, cy, r.w / 2 - 2, hex(PAL.ink));
  c.fillCircle(cx, cy, r.w / 2 - 5, hex(PAL.white));
  c.fillCircle(cx, cy + 2, r.w * 0.26, hex(PAL.ink)); // pupil
  c.fillCircle(cx + r.w * 0.10, cy - r.h * 0.08, r.w * 0.08, hex(PAL.white)); // catch-light
}

function drawEyeClosed(c, r) {
  // A flat ink lash line (down-curved capsule).
  c.fillRoundRect(r.x + 4, r.y + r.h / 2 - 4, r.w - 8, 9, 5, hex(PAL.ink));
}

function drawMouthNeutral(c, r) {
  c.fillRoundRect(r.x + 6, r.y + r.h / 2 - 3, r.w - 12, 7, 4, hex(PAL.ink));
}

function drawMouthOpen(c, r) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  c.fillEllipse(cx, cy, r.w / 2 - 4, r.h / 2 - 4, hex(PAL.ink));
  c.fillEllipse(cx, cy + 3, r.w / 2 - 9, r.h / 2 - 10, hex(PAL.mouth));
}

function drawMouthSmile(c, r) {
  // An upward arc: ink band masked to the lower half (drawn as a thick stroked round-rect crescent).
  c.strokeRoundRect(r.x + 6, r.y - r.h * 0.4, r.w - 12, r.h, r.h / 2, 7, hex(PAL.ink));
}

function drawBeak(c, r) {
  const cx = r.x + r.w / 2;
  c.fillEllipse(cx, r.y + r.h / 2, r.w / 2 - 3, r.h / 2 - 3, hex(PAL.beak));
  c.fillEllipse(cx, r.y + r.h / 2, r.w / 2 - 6, r.h / 2 - 6, hex(PAL.beak));
}

function drawLimb(c, r, color) {
  c.fillRoundRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, Math.min(r.w, r.h) / 2 - 1, hex(PAL.ink));
  c.fillRoundRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8, Math.min(r.w, r.h) / 2 - 3, hex(color));
}

function drawHand(c, r) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  c.fillCircle(cx, cy, r.w / 2 - 2, hex(PAL.ink));
  c.fillCircle(cx, cy, r.w / 2 - 5, hex(PAL.bodyDark));
}

function drawFoot(c, r) {
  c.fillEllipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2 - 2, r.h / 2 - 2, hex(PAL.ink));
  c.fillEllipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2 - 5, r.h / 2 - 5, hex(PAL.beak));
}

// ----------------------------------------------------------------------------------------------
// RENDER THE ATLAS PNG + build the tex.json (DragonBones SubTexture list).
// ----------------------------------------------------------------------------------------------
function buildAtlas() {
  const canvas = new Canvas(ATLAS_W, ATLAS_H);
  const sub = [];
  // Deterministic order (Object key order is stable for these string keys).
  for (const [name, p] of Object.entries(PARTS)) {
    p.draw(canvas, p);
    sub.push({ name, x: p.x, y: p.y, width: p.w, height: p.h });
  }
  const png = encodePNG(canvas);
  const tex = {
    width: ATLAS_W,
    height: ATLAS_H,
    name: NAME,
    imagePath: `${NAME}_tex.png`,
    SubTexture: sub,
  };
  return { png, tex };
}

// ----------------------------------------------------------------------------------------------
// BODY MESH (FFD source). A grid of vertices over the body sub-texture so authored deltas can
// squash/breathe it. Unweighted (no `weights`) → the spike-proven simple FFD path: deltas applied
// directly in mesh space.
//
// Mesh local space: DragonBones mesh `vertices` are in the SLOT's local coordinate frame. We build
// a COLS×ROWS grid spanning the body sub-texture's footprint, centred on the slot origin, with
// matching uvs into the body rect. Triangulated as two tris per cell.
// ----------------------------------------------------------------------------------------------
const BODY = PARTS.body;
const MESH_COLS = 5; // 5x6 grid → 30 verts; smooth blob squash, still compact to author
const MESH_ROWS = 6;

function buildBodyMesh() {
  const vertices = [];
  const uvs = [];
  // The mesh spans the PAINTED body region only (inset), so every vert samples opaque pixels.
  const w = BODY.w - 2 * BODY_INSET;
  const h = BODY.h - 2 * BODY_INSET;
  // Place the mesh so its centre sits at the slot origin (0,0).
  const offX = -w / 2;
  const offY = -h / 2;
  for (let row = 0; row < MESH_ROWS; row++) {
    for (let col = 0; col < MESH_COLS; col++) {
      const fx = col / (MESH_COLS - 1);
      const fy = row / (MESH_ROWS - 1);
      vertices.push(round2(offX + fx * w), round2(offY + fy * h));
      // uvs are normalized into the WHOLE atlas (DragonBones mesh uvs are atlas-relative 0..1).
      uvs.push(
        round4((BODY.x + BODY_INSET + fx * w) / ATLAS_W),
        round4((BODY.y + BODY_INSET + fy * h) / ATLAS_H),
      );
    }
  }
  const triangles = [];
  const idx = (r, col) => r * MESH_COLS + col;
  for (let row = 0; row < MESH_ROWS - 1; row++) {
    for (let col = 0; col < MESH_COLS - 1; col++) {
      const a = idx(row, col);
      const b = idx(row, col + 1);
      const cc = idx(row + 1, col);
      const d = idx(row + 1, col + 1);
      triangles.push(a, b, cc, b, d, cc);
    }
  }
  return { type: 'mesh', name: 'body', width: w, height: h, vertices, uvs, triangles };
}

const N_VERTS = MESH_COLS * MESH_ROWS;

// Authored FFD delta builders. Return a FLAT [dx0,dy0,...] of length 2*N_VERTS in mesh space.
// Deltas are PURE functions of the vertex grid position → deterministic, readable, on-style.

/** Breathe: vertical inflate/deflate — top rows rise, bottom rows widen slightly. amp in px. */
function ffdBreathe(amp) {
  const out = [];
  for (let row = 0; row < MESH_ROWS; row++) {
    const fy = row / (MESH_ROWS - 1); // 0 top .. 1 bottom
    for (let col = 0; col < MESH_COLS; col++) {
      const fx = col / (MESH_COLS - 1) - 0.5; // -0.5..0.5
      // chest lifts (top moves up), sides bulge out near the middle.
      const dy = -amp * (1 - fy); // top rises, bottom static
      const dx = amp * 0.5 * fx * Math.sin(fy * Math.PI); // mid widens
      out.push(round2(dx), round2(dy));
    }
  }
  return out;
}

/** Squash: classic squash-&-stretch — flatten vertically, widen horizontally. amp in px. */
function ffdSquash(amp) {
  const out = [];
  for (let row = 0; row < MESH_ROWS; row++) {
    const fy = row / (MESH_ROWS - 1) - 0.5; // -0.5 top .. 0.5 bottom
    for (let col = 0; col < MESH_COLS; col++) {
      const fx = col / (MESH_COLS - 1) - 0.5;
      const dy = -amp * fy * 1.4; // pull top down, bottom up → shorter
      const dx = amp * fx * 1.2; // push sides out → wider
      out.push(round2(dx), round2(dy));
    }
  }
  return out;
}

const ZERO_FFD = new Array(2 * N_VERTS).fill(0);

// ----------------------------------------------------------------------------------------------
// BONES. Transforms are local to the parent (DragonBones convention). y+ is DOWN in armature space.
// Hand-laid for a small upright blob: head above torso, arms on the sides, legs below the hip.
// ----------------------------------------------------------------------------------------------
const BONES = [
  { name: 'root' },
  { name: 'hip', parent: 'root', transform: { x: 0, y: -90 } },
  { name: 'torso', parent: 'hip', transform: { x: 0, y: -10 }, length: 90 },
  { name: 'head', parent: 'torso', transform: { x: 0, y: -140 }, length: 70 },
  // facial bones (children of head) — give visemes/eyes their own anchors.
  { name: 'eyeR', parent: 'head', transform: { x: -34, y: -8 } },
  { name: 'eyeL', parent: 'head', transform: { x: 34, y: -8 } },
  { name: 'mouth', parent: 'head', transform: { x: 0, y: 34 } },
  { name: 'beak', parent: 'head', transform: { x: 0, y: 16 } },
  // Right arm (character's right = screen left). Upper from torso shoulder, fore from elbow.
  { name: 'armR', parent: 'torso', transform: { x: -70, y: -10, skX: 110, skY: 110 }, length: 70 },
  { name: 'foreR', parent: 'armR', transform: { x: 70, y: 0, skX: 20, skY: 20 }, length: 64 },
  { name: 'armL', parent: 'torso', transform: { x: 70, y: -10, skX: 70, skY: 70 }, length: 70 },
  { name: 'foreL', parent: 'armL', transform: { x: 70, y: 0, skX: -20, skY: -20 }, length: 64 },
  // Legs from the hip.
  { name: 'legR', parent: 'hip', transform: { x: -36, y: 20, skX: 95, skY: 95 }, length: 66 },
  { name: 'shinR', parent: 'legR', transform: { x: 66, y: 0, skX: -10, skY: -10 }, length: 60 },
  { name: 'legL', parent: 'hip', transform: { x: 36, y: 20, skX: 85, skY: 85 }, length: 66 },
  { name: 'shinL', parent: 'legL', transform: { x: 66, y: 0, skX: 10, skY: 10 }, length: 60 },
];

// ----------------------------------------------------------------------------------------------
// SLOTS (draw order, back→front) + SKIN (display per slot). Limb slots draw behind the body; body
// behind head; facial parts in front of head.
// ----------------------------------------------------------------------------------------------
const SLOTS = [
  { name: 'legR', parent: 'legR' },
  { name: 'shinR', parent: 'shinR' },
  { name: 'footR', parent: 'shinR' },
  { name: 'legL', parent: 'legL' },
  { name: 'shinL', parent: 'shinL' },
  { name: 'footL', parent: 'shinL' },
  { name: 'armR', parent: 'armR' },
  { name: 'foreR', parent: 'foreR' },
  { name: 'handR', parent: 'foreR' },
  { name: 'armL', parent: 'armL' },
  { name: 'foreL', parent: 'foreL' },
  { name: 'handL', parent: 'foreL' },
  { name: 'body', parent: 'torso' }, // FFD mesh
  { name: 'head', parent: 'head' },
  { name: 'beak', parent: 'beak' },
  { name: 'mouth', parent: 'mouth' },
  { name: 'eyeR', parent: 'eyeR' },
  { name: 'eyeL', parent: 'eyeL' },
];

// An image display referencing an atlas sub-texture. `transform` positions the sprite in the slot's
// local space (DragonBones: pivot is the sub-texture centre by default; we offset via transform).
function img(name, dx = 0, dy = 0, extra = {}) {
  return { name, transform: { x: round2(dx), y: round2(dy), ...extra } };
}

function buildSkin(bodyMesh) {
  // Each slot lists its display(s). Multi-display slots (eyes, mouth) hold attachment-swap variants.
  return {
    name: '',
    slot: [
      { name: 'legR', display: [img('upperLeg', 30, 0)] },
      { name: 'shinR', display: [img('shin', 28, 0)] },
      { name: 'footR', display: [img('foot', 56, 4)] },
      { name: 'legL', display: [img('upperLeg', 30, 0)] },
      { name: 'shinL', display: [img('shin', 28, 0)] },
      { name: 'footL', display: [img('foot', 56, 4)] },
      { name: 'armR', display: [img('upperArm', 32, 0)] },
      { name: 'foreR', display: [img('foreArm', 28, 0)] },
      { name: 'handR', display: [img('hand', 60, 0)] },
      { name: 'armL', display: [img('upperArm', 32, 0)] },
      { name: 'foreL', display: [img('foreArm', 28, 0)] },
      { name: 'handL', display: [img('hand', 60, 0)] },
      // BODY: the FFD mesh display (no transform — mesh verts are already in slot space).
      { name: 'body', display: [bodyMesh] },
      { name: 'head', display: [img('head', 0, 0)] },
      { name: 'beak', display: [img('beak', 0, 0)] },
      // viseme-ready mouth: neutral default, then open + smile swaps.
      { name: 'mouth', display: [img('mouth_neutral', 0, 0), img('mouth_open', 0, 6), img('mouth_smile', 0, 0)] },
      // blink-ready eyes: open default, then closed swap.
      { name: 'eyeR', display: [img('eye_open', 0, 0), img('eye_closed', 0, 0)] },
      { name: 'eyeL', display: [img('eye_open', 0, 0), img('eye_closed', 0, 0)] },
    ],
  };
}

// ----------------------------------------------------------------------------------------------
// ANIMATIONS. v5.5 readable format: `bone` timelines (translate/rotate) + `ffd` deform timelines +
// `slot` displayFrame timelines (attachment swaps). All non-linear (tweenEasing curves) per r.7.
// ----------------------------------------------------------------------------------------------

// A bezier curve sample for DragonBones `curve` (4-control bezier, matches StyleKit "smooth").
const SMOOTH_CURVE = [0.4, 0, 0.2, 1];

// Build a rotate timeline frame.
function rotFrame(duration, rotate, curve = SMOOTH_CURVE) {
  return { duration, tweenEasing: null, curve: [...curve], rotate: round2(rotate) };
}
function transFrame(duration, x, y, curve = SMOOTH_CURVE) {
  return { duration, tweenEasing: null, curve: [...curve], x: round2(x), y: round2(y) };
}
// FFD frame: vertices = flat deltas. tweenEasing 0 = linear; we pass a curve for non-linear (r.7).
function ffdFrame(duration, vertices, curve = SMOOTH_CURVE) {
  return { duration, tweenEasing: null, curve: [...curve], offset: 0, vertices };
}
// slot display-swap frame (which display index is shown). Stepped (no tween on an attachment swap).
function dispFrame(duration, value) {
  return { duration, tweenEasing: null, value };
}

/**
 * IDLE (loop): a calm breathing cycle driven by AUTHORED FFD on the body mesh + a tiny torso bob.
 * Duration chosen so the breathe reads at ~ that period. The host RigLayer adds blink/sway on top.
 */
function animIdle() {
  const D = 72; // 3s at 24fps
  const half = D / 2;
  return {
    duration: D,
    playTimes: 0,
    name: 'idle',
    bone: [
      { name: 'torso', translateFrame: [transFrame(half, 0, 0), transFrame(half, 0, -4), transFrame(0, 0, 0)] },
      { name: 'head', translateFrame: [transFrame(half, 0, 0), transFrame(half, 0, -3), transFrame(0, 0, 0)] },
    ],
    ffd: [
      {
        name: 'body',
        slot: 'body',
        frame: [
          ffdFrame(half, [...ZERO_FFD]),
          ffdFrame(half, ffdBreathe(12)),
          ffdFrame(0, [...ZERO_FFD]),
        ],
      },
    ],
  };
}

/**
 * BLINK (one-shot): eyes swap open→closed→open via slot display timelines. Short.
 */
function animBlink() {
  const D = 12;
  const blinkSlot = (slot) => ({
    name: slot,
    displayFrame: [dispFrame(4, 0), dispFrame(4, 1), dispFrame(4, 0), dispFrame(0, 0)],
  });
  return {
    duration: D,
    playTimes: 1,
    name: 'blink',
    slot: [blinkSlot('eyeR'), blinkSlot('eyeL')],
  };
}

/**
 * WAVE (one-shot, expressive): the LEFT arm raises and waggles while the body does a squash beat
 * (AUTHORED FFD) and the mouth opens to a smile. Proves FFD composes with bone motion on a real
 * on-style character (spec §8 acceptance).
 */
function animWave() {
  const D = 48; // 2s
  return {
    duration: D,
    playTimes: 1,
    name: 'wave',
    bone: [
      // raise upper arm, then waggle the forearm back and forth.
      { name: 'armL', rotateFrame: [rotFrame(12, 0), rotFrame(36, -75), rotFrame(0, -75)] },
      {
        name: 'foreL',
        rotateFrame: [
          rotFrame(12, 0),
          rotFrame(9, -35),
          rotFrame(9, 20),
          rotFrame(9, -35),
          rotFrame(9, 20),
          rotFrame(0, 0),
        ],
      },
      // tiny anticipation dip in the torso.
      { name: 'torso', translateFrame: [transFrame(12, 0, 4), transFrame(12, 0, -2), transFrame(24, 0, 0), transFrame(0, 0, 0)] },
    ],
    ffd: [
      {
        name: 'body',
        slot: 'body',
        frame: [
          ffdFrame(12, ffdSquash(14)), // anticipation squash
          ffdFrame(12, ffdBreathe(8)), // stretch up as arm raises
          ffdFrame(24, [...ZERO_FFD]),
          ffdFrame(0, [...ZERO_FFD]),
        ],
      },
    ],
    slot: [
      // smile during the wave (display index 2 = mouth_smile), back to neutral at the end.
      { name: 'mouth', displayFrame: [dispFrame(12, 0), dispFrame(24, 2), dispFrame(12, 0), dispFrame(0, 0)] },
    ],
  };
}

// ----------------------------------------------------------------------------------------------
// ASSEMBLE + WRITE.
// ----------------------------------------------------------------------------------------------
function buildSkeleton() {
  const bodyMesh = buildBodyMesh();
  const armature = {
    type: 'Armature',
    frameRate: FRAME_RATE,
    name: ARMATURE,
    aabb: { x: -140, y: -340, width: 280, height: 380 },
    bone: BONES,
    slot: SLOTS,
    skin: [buildSkin(bodyMesh)],
    animation: [animIdle(), animBlink(), animWave()],
    defaultActions: [{ gotoAndPlay: 'idle' }],
  };
  return {
    frameRate: FRAME_RATE,
    name: NAME,
    version: VERSION,
    compatibleVersion: '5.5',
    armature: [armature],
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function main() {
  const { png, tex } = buildAtlas();
  const ske = buildSkeleton();

  const targets = [resolve(ROOT, 'library/characters/blip'), resolve(ROOT, 'public/blip')];
  for (const dir of targets) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${NAME}_ske.json`), JSON.stringify(ske) + '\n');
    writeFileSync(resolve(dir, `${NAME}_tex.json`), JSON.stringify(tex) + '\n');
    writeFileSync(resolve(dir, `${NAME}_tex.png`), png);
  }
  // Telemetry for the build log (not part of determinism).
  console.log(`[gen-blip-rig] wrote ${NAME}_ske.json (${JSON.stringify(ske).length}B), ` +
    `${NAME}_tex.json, ${NAME}_tex.png (${png.length}B) to ${targets.length} dirs`);
  console.log(`[gen-blip-rig] bones=${BONES.length} slots=${SLOTS.length} ` +
    `mesh_verts=${N_VERTS} anims=${ske.armature[0].animation.map((a) => a.name).join(',')}`);
}

main();
