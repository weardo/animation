// Gemini free-tier client — the ONE place that talks to Google's Generative Language API. Two capabilities
// this project benefits from on the FREE tier (no credit card): search-grounded TEXT (richer research) and
// Nano Banana IMAGE generation (custom illustrations). Everything here is BUILD-TIME only and its output is
// content-addressed cached by the callers (imagegen / research), so a stochastic Gemini call runs ONCE and
// the render replays a FIXED artifact — determinism preserved (golden rule 1/2).
//
// GATED: every function needs GEMINI_API_KEY (env-only, never committed). Absent → a typed NoKeyError so the
// caller falls back to today's behavior (Wikimedia/footage; claude -p + GDELT). Model ids are env-overridable
// so a Google rename never needs a code edit. Free tier is ~10 RPM — we serialize + retry once on 429/5xx.
const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
// Verified against a live free-tier key (2026-07): `gemini-2.5-flash` is retired for new users →
// `gemini-flash-latest`. Nano Banana image models have 0 FREE quota (need billing); IMAGEN 4 FAST has 25
// images/day FREE, so it's the default image backend. Search grounding is 1.5K RPD free on Gemini 2.5.
const TEXT_MODEL = process.env['GEMINI_TEXT_MODEL'] ?? 'gemini-flash-latest';
const IMAGE_MODEL = process.env['GEMINI_IMAGE_MODEL'] ?? 'imagen-4.0-fast-generate-001';

export class NoKeyError extends Error {
  constructor() {
    super('GEMINI_API_KEY not set');
    this.name = 'NoKeyError';
  }
}

export function hasGeminiKey(): boolean {
  return Boolean(process.env['GEMINI_API_KEY']);
}

// Serialize + gently space calls (free tier ~10 RPM). Shared across text + image.
let gate: Promise<void> = Promise.resolve();
function throttle(): Promise<void> {
  const wait = gate.then(() => new Promise<void>((r) => setTimeout(r, 900)));
  gate = wait;
  return wait;
}

async function post(model: string, body: unknown, method: 'generateContent' | 'predict' = 'generateContent'): Promise<Record<string, unknown>> {
  const key = process.env['GEMINI_API_KEY'];
  if (!key) throw new NoKeyError();
  const url = `${API_ROOT}/${model}:${method}`;
  const doFetch = (): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  await throttle();
  let res = await doFetch();
  if (res.status === 429 || res.status >= 500) {
    await new Promise((r) => setTimeout(r, 3000));
    res = await doFetch();
  }
  if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, unknown>;
}

interface Part { text?: string; inlineData?: { mimeType?: string; data?: string } }
interface Candidate {
  content?: { parts?: Part[] };
  groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
}

/**
 * Generate text with Gemini Flash. `search:true` attaches the Google-Search grounding tool → current, cited
 * facts (returns the source URLs in `sources`). Throws NoKeyError with no key. Build-time; cache the result.
 */
export async function geminiText(
  prompt: string,
  opts: { search?: boolean; model?: string; systemInstruction?: string } = {},
): Promise<{ text: string; sources: string[] }> {
  const body: Record<string, unknown> = { contents: [{ parts: [{ text: prompt }] }] };
  if (opts.search) body['tools'] = [{ google_search: {} }];
  if (opts.systemInstruction) body['systemInstruction'] = { parts: [{ text: opts.systemInstruction }] };
  const data = await post(opts.model ?? TEXT_MODEL, body);
  const cand = ((data['candidates'] as Candidate[] | undefined) ?? [])[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  const sources = (cand?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web?.uri)
    .filter((u): u is string => Boolean(u));
  return { text, sources: [...new Set(sources)] };
}

/**
 * Generate ONE image → a PNG Buffer. Defaults to IMAGEN 4 FAST (`imagen-4.0-fast-generate-001`, 25/day FREE)
 * via the `:predict` endpoint; a Nano Banana model id (`gemini-*-image`) routes through `:generateContent`
 * instead (needs billing). Returns null if the response carried no image (safety block). Throws NoKeyError
 * with no key. Build-time; cache the PNG. `aspectRatio` ∈ {1:1,9:16,16:9,3:4,4:3} (Imagen only).
 */
export async function geminiImage(
  prompt: string,
  opts: { model?: string; aspectRatio?: string } = {},
): Promise<Buffer | null> {
  const model = opts.model ?? IMAGE_MODEL;
  if (/imagen/i.test(model)) {
    // Imagen predict API: {instances:[{prompt}], parameters:{sampleCount, aspectRatio}} → predictions[].bytesBase64Encoded
    const body = {
      instances: [{ prompt }],
      parameters: { sampleCount: 1, ...(opts.aspectRatio ? { aspectRatio: opts.aspectRatio } : {}) },
    };
    const data = await post(model, body, 'predict');
    const preds = (data['predictions'] as Array<{ bytesBase64Encoded?: string }> | undefined) ?? [];
    const b64 = preds[0]?.bytesBase64Encoded;
    return b64 ? Buffer.from(b64, 'base64') : null;
  }
  // Nano Banana (gemini-*-image) via generateContent → inlineData part.
  const data = await post(model, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } });
  const cand = ((data['candidates'] as Candidate[] | undefined) ?? [])[0];
  for (const part of cand?.content?.parts ?? []) {
    if (part.inlineData?.data) return Buffer.from(part.inlineData.data, 'base64');
  }
  return null;
}
