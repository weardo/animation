// perceptual-diff — compare two renders PERCEPTUALLY (SSIM + PSNR), not byte-exact. For the GPU tier
// (ADR-003 / DECISIONS): GPU raster is only *visually* identical run-to-run (~47-50dB), so we verify
// "the variation is imperceptible" with a threshold instead of a byte match. CPU tier stays byte-exact.
//
//   node tools/perceptual-diff.mjs <a.mp4> <b.mp4> [minPsnr=40] [minSsim=0.99]
//
// Exit 0 + "IMPERCEPTIBLE" if both thresholds pass (visually lossless); exit 1 + "PERCEPTIBLE" else.
// PSNR ≥ 40 dB and SSIM ≥ 0.99 are the standard "visually lossless" bars.

import { spawnSync } from 'node:child_process';

const [a, b, minPsnrArg, minSsimArg] = process.argv.slice(2);
if (!a || !b) {
  console.error('usage: node tools/perceptual-diff.mjs <a.mp4> <b.mp4> [minPsnr=40] [minSsim=0.99]');
  process.exit(2);
}
const minPsnr = Number(minPsnrArg ?? 40);
const minSsim = Number(minSsimArg ?? 0.99);

/** Run an ffmpeg lavfi metric over the two videos and return its stderr (where ffmpeg prints stats,
 *  whether it exits 0 or not). spawnSync captures stderr unconditionally (execFileSync drops it on success). */
function ffmpegMetric(filter) {
  const r = spawnSync('ffmpeg', ['-i', a, '-i', b, '-lavfi', `[0:v][1:v]${filter}`, '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return (r.stderr ?? '') + (r.stdout ?? '');
}

const ssimOut = ffmpegMetric('ssim');
const psnrOut = ffmpegMetric('psnr');

const ssim = Number((ssimOut.match(/All:\s*([0-9.]+)/) ?? [])[1] ?? NaN);
const psnrM = psnrOut.match(/average:\s*([0-9.]+|inf)/);
const psnr = psnrM ? (psnrM[1] === 'inf' ? Infinity : Number(psnrM[1])) : NaN;

const ok = ssim >= minSsim && psnr >= minPsnr;
console.log(`SSIM=${Number.isFinite(ssim) ? ssim.toFixed(5) : ssim}  PSNR=${psnr === Infinity ? 'inf' : psnr.toFixed(2)}dB  (thresholds SSIM≥${minSsim}, PSNR≥${minPsnr})`);
console.log(ok ? 'IMPERCEPTIBLE ✓ (visually lossless)' : 'PERCEPTIBLE ✗ (difference exceeds threshold)');
process.exit(ok ? 0 : 1);
