// perceptual-diff — compare two renders by PERCEPTUAL quality, not byte-exact. For the GPU tier
// (ADR-003 / DECISIONS): GPU raster is only *visually* identical run-to-run, so we verify "the
// variation is imperceptible" with perceptual metrics instead of a byte match. CPU tier stays byte-exact.
//
//   node tools/perceptual-diff.mjs <a.mp4> <b.mp4> [minVmaf=90]
//
// PRIMARY metric: VMAF (Netflix; a learned perceptual model — far better than pixel math, which a
// uniform blur can fool). VMAF ≥ 90 = "excellent" (the streaming gold standard); for run-to-run
// render identity expect ~98-100. SSIM + PSNR are reported as secondary signals.
// Exit 0 + "EXCELLENT" if VMAF ≥ threshold; exit 1 otherwise.

import { spawnSync } from 'node:child_process';

const [a, b, minVmafArg] = process.argv.slice(2);
if (!a || !b) {
  console.error('usage: node tools/perceptual-diff.mjs <a.mp4> <b.mp4> [minVmaf=90]');
  process.exit(2);
}
const minVmaf = Number(minVmafArg ?? 90);

/** Run an ffmpeg lavfi metric over the two videos; return combined stderr+stdout (ffmpeg prints
 *  stats to stderr whether it exits 0 or not — spawnSync captures it unconditionally). */
function ffmpegMetric(filter) {
  const r = spawnSync('ffmpeg', ['-i', a, '-i', b, '-lavfi', `[0:v][1:v]${filter}`, '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return (r.stderr ?? '') + (r.stdout ?? '');
}

// VMAF (primary). 2nd input is the reference; threaded for speed. Built-in default model (vmaf_v0.6.1).
const vmafOut = ffmpegMetric('libvmaf=n_threads=8');
const vmaf = Number((vmafOut.match(/VMAF score:\s*([0-9.]+)/) ?? [])[1] ?? NaN);

// SSIM + PSNR (secondary signals).
const ssim = Number((ffmpegMetric('ssim').match(/All:\s*([0-9.]+)/) ?? [])[1] ?? NaN);
const psnrM = ffmpegMetric('psnr').match(/average:\s*([0-9.]+|inf)/);
const psnr = psnrM ? (psnrM[1] === 'inf' ? Infinity : Number(psnrM[1])) : NaN;

const ok = Number.isFinite(vmaf) && vmaf >= minVmaf;
console.log(`VMAF=${Number.isFinite(vmaf) ? vmaf.toFixed(3) : 'n/a'} (threshold ≥${minVmaf})   [SSIM=${Number.isFinite(ssim) ? ssim.toFixed(5) : 'n/a'}  PSNR=${psnr === Infinity ? 'inf' : Number.isFinite(psnr) ? psnr.toFixed(2) + 'dB' : 'n/a'}]`);
console.log(ok ? 'EXCELLENT ✓ (perceptually excellent — VMAF gold standard)' : `BELOW THRESHOLD ✗ (VMAF ${Number.isFinite(vmaf) ? vmaf.toFixed(1) : 'n/a'} < ${minVmaf})`);
process.exit(ok ? 0 : 1);
