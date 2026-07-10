// Image-generation PROVIDER POOL — the "reuse over invent" answer to free image gen (golden rule 3). Rather
// than one paid backend or a heavyweight gateway service, this is a thin ORDERED CHAIN of FREE FLUX-quality
// providers: try each in priority order, on error/quota/timeout fall through to the next. The COLLECTIVE free
// quota is the sum of all tiers, and it NEVER hard-fails (Pollinations + AI Horde are keyless, free-forever
// backstops). Every result is content-addressed cached by the caller (imagegen), so real volume is tiny.
//
// All BUILD-TIME only; each provider is gated by its own env key (or keyless). A provider with no key is
// skipped. Order (fast+best first → keyless backstops last):
//   Cloudflare FLUX (daily, your account) → Pollinations (keyless) → AI Horde (keyless, free-forever)
//   → Gemini/Imagen (only if billing enabled)
import { geminiImage, hasGeminiKey } from './gemini.js';

export interface ImageGenParams {
  prompt: string;
  width: number;
  height: number;
  seed: number;
}

export interface ImageProvider {
  name: string;
  available(): boolean;
  generate(p: ImageGenParams): Promise<Buffer | null>;
}

const UA = 'india-storyboard/1.0 (news-reel factory)';

/** Cloudflare Workers AI — FLUX-1-schnell. 10,000 neurons/day FREE. Needs a token with the Workers AI perm
 *  (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID). Returns null on auth/quota/error → the pool falls through. */
const cloudflare: ImageProvider = {
  name: 'cloudflare-flux',
  available: () => Boolean(process.env['CLOUDFLARE_API_TOKEN'] && process.env['CLOUDFLARE_ACCOUNT_ID']),
  async generate({ prompt, seed }) {
    try {
      const acc = process.env['CLOUDFLARE_ACCOUNT_ID'];
      const tok = process.env['CLOUDFLARE_API_TOKEN'];
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, steps: 4, seed }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { success?: boolean; result?: { image?: string } };
      const b64 = j.success ? j.result?.image : undefined;
      return b64 ? Buffer.from(b64, 'base64') : null;
    } catch {
      return null;
    }
  },
};

/** Pollinations.ai — keyless, free, FLUX-based. Just a URL → image bytes. Verified working with no signup. */
const pollinations: ImageProvider = {
  name: 'pollinations',
  available: () => true,
  async generate({ prompt, width, height, seed }) {
    try {
      const u =
        `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
        `?width=${width}&height=${height}&seed=${seed}&model=flux&nologo=true`;
      const res = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      // Guard against an HTML error page slipping through as "200".
      const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      return buf.length > 1024 && (isJpg || isPng) ? buf : null;
    } catch {
      return null;
    }
  },
};

/** AI Horde (Stable Horde) — crowdsourced, open-source, FREE-FOREVER, keyless (anon apikey). Slower (a queue),
 *  so it's the LAST-resort backstop. Async: submit → poll → fetch the result image. Time-bounded. */
const aiHorde: ImageProvider = {
  name: 'ai-horde',
  available: () => true,
  async generate({ prompt, width, height }) {
    const apikey = process.env['AI_HORDE_API_KEY'] || '0000000000'; // '0000000000' = anonymous (lowest priority)
    const headers = { apikey, 'content-type': 'application/json', 'Client-Agent': UA };
    const round8 = (n: number): number => Math.max(64, Math.min(1024, Math.round(n / 64) * 64));
    try {
      const submit = await fetch('https://aihorde.net/api/v2/generate/async', {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt, params: { width: round8(width), height: round8(height), steps: 8, n: 1 } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!submit.ok) return null;
      const { id } = (await submit.json()) as { id?: string };
      if (!id) return null;
      // Poll up to ~2.5 min (community queue). Give up → the pool already tried faster providers first.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const chk = await fetch(`https://aihorde.net/api/v2/generate/check/${id}`, { headers, signal: AbortSignal.timeout(20_000) });
        if (!chk.ok) continue;
        const st = (await chk.json()) as { done?: boolean; faulted?: boolean };
        if (st.faulted) return null;
        if (st.done) break;
      }
      const status = await fetch(`https://aihorde.net/api/v2/generate/status/${id}`, { headers, signal: AbortSignal.timeout(20_000) });
      if (!status.ok) return null;
      const sj = (await status.json()) as { generations?: Array<{ img?: string }> };
      const img = sj.generations?.[0]?.img;
      if (!img) return null;
      if (/^https?:\/\//.test(img)) {
        const r = await fetch(img, { signal: AbortSignal.timeout(30_000) });
        return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
      }
      return Buffer.from(img, 'base64');
    } catch {
      return null;
    }
  },
};

/** Together AI — FLUX.1-schnell-Free. 3 MONTHS of FREE UNLIMITED access (then paid). Needs TOGETHER_API_KEY. */
const together: ImageProvider = {
  name: 'together-flux',
  available: () => Boolean(process.env['TOGETHER_API_KEY']),
  async generate({ prompt, width, height, seed }) {
    try {
      const res = await fetch('https://api.together.xyz/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env['TOGETHER_API_KEY']}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'black-forest-labs/FLUX.1-schnell-Free', prompt, width, height, steps: 4, n: 1, seed, response_format: 'b64_json' }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      const d = j.data?.[0];
      if (d?.b64_json) return Buffer.from(d.b64_json, 'base64');
      if (d?.url) { const r = await fetch(d.url, { signal: AbortSignal.timeout(30_000) }); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; }
      return null;
    } catch {
      return null;
    }
  },
};

/** Hugging Face Inference — FLUX.1-schnell. Free tier (hundreds/hour). Needs HF_TOKEN. Returns image bytes. */
const huggingface: ImageProvider = {
  name: 'huggingface-flux',
  available: () => Boolean(process.env['HF_TOKEN']),
  async generate({ prompt }) {
    try {
      const model = process.env['HF_IMAGE_MODEL'] ?? 'black-forest-labs/FLUX.1-schnell';
      const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env['HF_TOKEN']}`, 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: prompt }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      return buf.length > 1024 && (isJpg || isPng) ? buf : null;
    } catch {
      return null;
    }
  },
};

/** Gemini / Imagen — only when billing is enabled (0 free quota). Kept last: prefer the free FLUX providers. */
const gemini: ImageProvider = {
  name: 'gemini-imagen',
  available: () => hasGeminiKey(),
  async generate({ prompt }) {
    try {
      return await geminiImage(prompt);
    } catch {
      return null;
    }
  },
};

/** The ordered pool. Keyed daily/unlimited-free first → keyless free-forever backstops → billing-only last.
 *  A provider with no key is skipped, so the chain adapts to whatever keys are present. */
const POOL: ImageProvider[] = [cloudflare, together, huggingface, pollinations, aiHorde, gemini];

/** Try each AVAILABLE provider in order; return the first image + which provider made it. null → all failed. */
export async function generateFromPool(p: ImageGenParams): Promise<{ buffer: Buffer; provider: string } | null> {
  for (const provider of POOL) {
    if (!provider.available()) continue;
    const buffer = await provider.generate(p);
    if (buffer && buffer.length > 0) return { buffer, provider: provider.name };
  }
  return null;
}
