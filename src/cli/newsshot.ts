// factory:newsshot — OFFLINE screenshot of a PUBLIC news article → a still asset used as documentary
// EVIDENCE (the rapid ubiquity montage, "everyone is reporting this").
//
// JOURNALISM / FAIR USE: this captures PUBLICLY-ACCESSIBLE pages only, for brief, attributed,
// transformative commentary. The publisher + URL + capture date are recorded in provenance so the shot is
// always source-attributed on-screen + in the description. No paywall/DRM circumvention.
//
// Golden rule 1/2: screenshot ONCE OFFLINE into a content-addressed PNG cache (skip-if-exists); the render
// replays the FIXED PNG via the existing AssetLayer (<Img>) → byte-deterministic even though a live page
// isn't. Reuses REMOTION'S already-installed Chromium (via ensureBrowser()) driven by puppeteer-core — no
// extra ~300 MB browser download.
//
// USAGE:
//   factory:newsshot "<url>" --id <asset-id> [--selector "<css>"] [--full-page]
//                    [--width 1200] [--height 1600] [--wait 1500] [--date 2026-07-08]
// Then in a story:  { asset: <id>, as: clip1, args: { z: 5, kenburns: "in" } }   (montage: many short beats)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import objectHash from 'object-hash';
import { ensureBrowser } from '@remotion/renderer';
// eslint-disable-next-line import/no-extraneous-dependencies
import puppeteer from 'puppeteer-core';

interface ShotRequest {
  url: string;
  selector?: string;
  fullPage: boolean;
  width: number;
  height: number;
  wait: number;
}

function shotHash(req: ShotRequest): string {
  return objectHash({ u: req.url, s: req.selector ?? '', f: req.fullPage, w: req.width, h: req.height }).slice(0, 12);
}

async function capture(req: ShotRequest, outPath: string): Promise<{ publisher: string }> {
  const execPath = (await ensureBrowser() as { path: string }).path; // Remotion's chromium
  const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--hide-scrollbars', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: req.width, height: req.height, deviceScaleFactor: 2 });
    await page.goto(req.url, { waitUntil: 'networkidle2', timeout: 45000 });
    // Best-effort: dismiss obvious cookie/consent overlays that would cover the article.
    await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i]'))) {
        (el as HTMLElement).style.display = 'none';
      }
    }).catch(() => {});
    if (req.wait > 0) await new Promise((r) => setTimeout(r, req.wait));
    const publisher = await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content');
      return og || location.hostname.replace(/^www\./, '');
    }).catch(() => new URL(req.url).hostname.replace(/^www\./, ''));

    if (req.selector) {
      const el = await page.$(req.selector);
      if (!el) throw new Error(`selector "${req.selector}" not found on ${req.url}`);
      await el.screenshot({ path: outPath as `${string}.png` });
    } else {
      await page.screenshot({ path: outPath as `${string}.png`, fullPage: req.fullPage });
    }
    return { publisher };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const url = argv.find((a) => !a.startsWith('-'));
  const flag = (n: string): string | undefined => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined);
  if (!url || !/^https?:\/\//.test(url)) {
    console.error('usage: factory:newsshot "<https url>" --id <asset-id> [--selector "<css>"] [--full-page] [--width 1200] [--height 1600] [--wait 1500] [--date YYYY-MM-DD]');
    process.exit(1);
  }
  const rootDir = flag('--root') ?? process.cwd();
  const sel = flag('--selector');
  const req: ShotRequest = {
    url,
    ...(sel ? { selector: sel } : {}),
    fullPage: argv.includes('--full-page'),
    width: Number(flag('--width') ?? '1200'),
    height: Number(flag('--height') ?? '1600'),
    wait: Number(flag('--wait') ?? '1200'),
  };
  const id = (flag('--id') ?? `news-${shotHash(req)}`).replace(/[^a-z0-9_-]/gi, '-');
  const date = flag('--date') ?? '';

  const imgDir = resolvePath(rootDir, 'public', 'img');
  mkdirSync(imgDir, { recursive: true });
  const outPath = resolvePath(imgDir, `${id}.png`);
  const uri = `asset://img/${id}.png`;
  const hash = shotHash(req);

  let publisher = new URL(url).hostname.replace(/^www\./, '');
  if (existsSync(outPath)) {
    console.log(`[newsshot] cached "${id}" (hash ${hash}) — reusing ${outPath}`);
  } else {
    console.log(`[newsshot] capturing ${url} …`);
    ({ publisher } = await capture(req, outPath));
    console.log(`[newsshot] → ${uri}  (publisher: ${publisher})`);
  }

  registerCatalog(rootDir, id, uri, url, publisher, date, hash);
  console.log(`[newsshot]   use  → a montage beat: { asset: ${id}, as: shot, args: { z: 5, kenburns: "in" } }`);
  console.log(`[newsshot]   ⚖  editorial/fair-use — keep it BRIEF + attribute "${publisher}" on-screen + in the description.`);
}

function registerCatalog(rootDir: string, id: string, uri: string, url: string, publisher: string, date: string, hash: string): void {
  const idxPath = resolvePath(rootDir, 'library', 'index.json');
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  idx.entries ??= {};
  idx.entries.newsshots ??= {};
  const prev = idx.entries.newsshots[id] ?? {};
  idx.entries.newsshots[id] = {
    id,
    version: (prev.version as string | undefined) ?? '1.0.0',
    kind: 'asset',
    format: 'image',
    uri,
    tags: ['newsshot', 'evidence', 'screenshot'],
    deps: [],
    provenance: {
      source: `${publisher} — ${url}${date ? ` (captured ${date})` : ''}`,
      license: 'editorial / fair-use — brief attributed commentary; publicly-accessible source',
      cache_hash: hash,
    },
  };
  writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');
  console.log(`[newsshot]   catalog → library/index.json  (${uri})`);
}

main().catch((err) => {
  console.error(`[newsshot] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
