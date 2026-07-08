// YouTube publisher — uploads a rendered reel via the YouTube Data API v3 (`videos.insert`, resumable)
// + sets the thumbnail. Hand-rolled on stdlib + global `fetch` (no `googleapis` dep), mirroring the
// minimal-dependency style of sarvam_synth / footage.
//
// AUTH: uploads need OAuth 2.0 (an API key is NOT enough). One-time free setup by the user:
//   1. Google Cloud project → enable "YouTube Data API v3".
//   2. Create an OAuth client of type **Desktop app** → download the client JSON.
//   3. Put its client_id/client_secret in env (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET) OR save the
//      downloaded file at ~/.config/animation-factory/youtube_client.json.
//   4. Run `factory:publish <project> --platform youtube --auth` ONCE — a loopback consent flow saves a
//      refresh token to ~/.config/animation-factory/youtube_token.json.
// After that, `factory:publish` refreshes an access token per upload — no further interaction.
//
// ⚠️ GOOGLE CONSTRAINT: until the OAuth app passes Google's verification/audit, API-uploaded videos are
// FORCE-LOCKED to private/unlisted regardless of the requested visibility. So `public` may silently come
// back as `unlisted` on an unverified app — which is also why we default to unlisted and treat public as
// an explicit, human-eyeballed step.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { Publisher, PublishContext, PublishResult, Visibility } from './types.js';

const CONFIG_DIR = resolvePath(homedir(), '.config', 'animation-factory');
const CLIENT_FILE = join(CONFIG_DIR, 'youtube_client.json');
const TOKEN_FILE = join(CONFIG_DIR, 'youtube_token.json');
const LOOPBACK_PORT = 8723;
const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}`;
// youtube.upload = insert videos; youtube.force-ssl = set thumbnails on your own video.
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.force-ssl'];

// YouTube category NAME → categoryId (the common set; US-region ids, stable across locales).
const CATEGORY_IDS: Record<string, string> = {
  'Film & Animation': '1', 'Autos & Vehicles': '2', Music: '10', 'Pets & Animals': '15',
  Sports: '17', 'Travel & Events': '19', Gaming: '20', 'People & Blogs': '22', Comedy: '23',
  Entertainment: '24', 'News & Politics': '25', 'Howto & Style': '26', Education: '27',
  'Science & Technology': '28', 'Nonprofits & Activism': '29',
};

interface ClientCreds {
  client_id: string;
  client_secret: string;
}

/** Load OAuth client creds from env first, then the downloaded client JSON (`{installed|web:{...}}`). */
function loadClientCreds(): ClientCreds | undefined {
  const envId = process.env['YOUTUBE_CLIENT_ID'];
  const envSecret = process.env['YOUTUBE_CLIENT_SECRET'];
  if (envId && envSecret) return { client_id: envId, client_secret: envSecret };
  if (existsSync(CLIENT_FILE)) {
    const raw = JSON.parse(readFileSync(CLIENT_FILE, 'utf8'));
    const c = raw.installed ?? raw.web ?? raw;
    if (c?.client_id && c?.client_secret) return { client_id: c.client_id, client_secret: c.client_secret };
  }
  return undefined;
}

function loadRefreshToken(): string | undefined {
  if (!existsSync(TOKEN_FILE)) return undefined;
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf8')).refresh_token;
  } catch {
    return undefined;
  }
}

/** Exchange a refresh token for a short-lived access token. */
async function accessTokenFromRefresh(creds: ClientCreds, refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) throw new Error(`token refresh failed ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('no access_token in refresh response');
  return data.access_token;
}

/** One-time OAuth consent via a localhost loopback: print/open the URL, catch the redirect, save token. */
async function runAuthFlow(): Promise<void> {
  const creds = loadClientCreds();
  if (!creds) {
    throw new Error(
      `no OAuth client creds. Set YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET, or save the GCP OAuth-client JSON at ${CLIENT_FILE}.`,
    );
  }
  // CSRF: a random `state` bound to THIS flow — the callback is rejected unless it echoes it back, so a
  // code from any other (attacker-initiated) grant can't be injected into our loopback.
  const state = randomBytes(32).toString('base64url');
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: creds.client_id,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    }).toString();

  // Escape anything reflected into the callback HTML (defends the localhost page against a crafted
  // ?error=<script> during the brief listen window).
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);

  const code = await new Promise<string>((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      const c = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      // Reject any callback whose `state` doesn't match this flow's (CSRF guard).
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>❌ state mismatch — ignored.</h2></body></html>');
        server.close();
        reject(new Error('auth failed: state mismatch (possible CSRF)'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<html><body style="font-family:system-ui;background:#0a0d14;color:#f5f7fa;text-align:center;padding-top:20vh"><h2>${c ? '✅ Authorized — you can close this tab.' : '❌ ' + esc(err ?? 'no code')}</h2></body></html>`,
      );
      server.close();
      if (c) resolvePromise(c);
      else reject(new Error(`auth failed: ${err ?? 'no code'}`));
    });
    server.on('error', reject);
    server.listen(LOOPBACK_PORT, '127.0.0.1', () => {
      console.log(`[publish:youtube] open this URL to authorize (a browser tab), then return here:\n\n  ${authUrl}\n`);
      execFile('xdg-open', [authUrl], () => {}); // best-effort auto-open; harmless if it fails
    });
  });

  // Exchange the code for tokens (incl. the long-lived refresh_token).
  const body = new URLSearchParams({
    code,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) throw new Error(`code exchange failed ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as { refresh_token?: string };
  if (!data.refresh_token) {
    throw new Error('no refresh_token returned (revoke prior grant at myaccount.google.com/permissions and retry — needs prompt=consent).');
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: data.refresh_token }, null, 2) + '\n', { mode: 0o600 });
  console.log(`[publish:youtube] ✅ authorized — refresh token saved to ${TOKEN_FILE}`);
}

/** Build the YouTube video-resource metadata from the generic PublishMeta. */
function buildVideoResource(ctx: PublishContext): Record<string, unknown> {
  const { meta, visibility } = ctx;
  // Append hashtags to the description so they render as clickable #tags (YouTube shows the first 3).
  const hashtagLine = meta.hashtags.length ? '\n\n' + meta.hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ') : '';
  return {
    snippet: {
      title: meta.title.slice(0, 100),
      description: (meta.description + hashtagLine).slice(0, 5000),
      tags: meta.tags,
      categoryId: CATEGORY_IDS[meta.category] ?? '25', // default News & Politics
      ...(meta.language ? { defaultLanguage: meta.language, defaultAudioLanguage: meta.language } : {}),
    },
    status: {
      privacyStatus: visibility,
      selfDeclaredMadeForKids: meta.madeForKids,
      license: 'youtube',
      embeddable: true,
    },
  };
}

async function uploadVideo(ctx: PublishContext, accessToken: string): Promise<string> {
  const size = statSync(ctx.videoPath).size;
  // 1. Start a resumable session — metadata in the body, bytes to follow at the returned Location.
  const initResp = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify(buildVideoResource(ctx)),
    },
  );
  if (!initResp.ok) throw new Error(`resumable init failed ${initResp.status}: ${(await initResp.text()).slice(0, 300)}`);
  const sessionUri = initResp.headers.get('location');
  if (!sessionUri) throw new Error('no resumable session URI (Location header) returned');

  // 2. PUT the whole file (reels are small; a single PUT is a valid resumable upload).
  const bytes = readFileSync(ctx.videoPath);
  const putResp = await fetch(sessionUri, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) },
    body: bytes,
  });
  if (!putResp.ok) throw new Error(`upload PUT failed ${putResp.status}: ${(await putResp.text()).slice(0, 300)}`);
  const data = (await putResp.json()) as { id?: string };
  if (!data.id) throw new Error('upload succeeded but no video id returned');
  return data.id;
}

/** Best-effort custom thumbnail (non-fatal — YouTube also auto-picks one). */
async function setThumbnail(videoId: string, thumbPath: string, accessToken: string): Promise<boolean> {
  try {
    const bytes = readFileSync(thumbPath);
    const ct = thumbPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const resp = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': ct },
      body: bytes,
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export class YouTubePublisher implements Publisher {
  readonly platform = 'youtube';
  readonly requires =
    'a Google Cloud OAuth "Desktop" client (YOUTUBE_CLIENT_ID/SECRET or ~/.config/animation-factory/youtube_client.json) + one-time `--auth` consent';

  isConfigured(): boolean {
    return loadClientCreds() !== undefined && loadRefreshToken() !== undefined;
  }

  async authenticate(): Promise<void> {
    await runAuthFlow();
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const creds = loadClientCreds();
    const refresh = loadRefreshToken();
    const authed = Boolean(creds && refresh);

    // DRY-RUN: show the metadata preview whether or not creds exist (validates the file + mapping).
    if (ctx.dryRun) {
      const res = buildVideoResource(ctx) as { snippet: { title: string; categoryId: string } };
      const authNote = authed
        ? 'creds OK — pass --yes to upload'
        : creds
          ? `client creds OK, not yet authorized — run \`factory:publish ${ctx.projectId} --platform youtube --auth\``
          : `no client creds — set YOUTUBE_CLIENT_ID/SECRET or ${CLIENT_FILE}, then --auth`;
      return {
        platform: this.platform,
        status: 'dry-run',
        visibility: ctx.visibility,
        message: `would upload "${res.snippet.title}" (category ${res.snippet.categoryId}, ${ctx.meta.tags.length} tags, ${(statSync(ctx.videoPath).size / 1e6).toFixed(1)} MB) as ${ctx.visibility}${ctx.thumbnailPath ? ' + thumbnail' : ''}. ${authNote}.`,
      };
    }

    if (!creds || !refresh) {
      return {
        platform: this.platform,
        status: 'failed',
        message: `not authorized — run \`factory:publish ${ctx.projectId} --platform youtube --auth\` first (${this.requires}).`,
      };
    }

    try {
      const accessToken = await accessTokenFromRefresh(creds, refresh);
      const id = await uploadVideo(ctx, accessToken);
      let message = `uploaded as ${ctx.visibility}`;
      if (ctx.thumbnailPath && existsSync(ctx.thumbnailPath)) {
        const ok = await setThumbnail(id, ctx.thumbnailPath, accessToken);
        message += ok ? ' + thumbnail' : ' (thumbnail skipped)';
      }
      if (ctx.visibility === 'public') {
        message += '. NOTE: if the OAuth app is unverified, YouTube may force it to unlisted — check in Studio.';
      }
      return {
        platform: this.platform,
        status: 'uploaded',
        id,
        url: `https://youtu.be/${id}`,
        visibility: ctx.visibility,
        message,
      };
    } catch (err) {
      return { platform: this.platform, status: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const YOUTUBE_STUDIO = (id: string): string => `https://studio.youtube.com/video/${id}/edit`;
export type { Visibility };
