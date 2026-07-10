// Research agent — the FACT-FIRST stage. Before a single word of narration is written, this gathers the
// ACTUAL facts of a story (what/when/where/who/numbers/specific incidents) from real sources and distills
// them into a structured FactSheet the Story Architect must ground every beat in. This is the fix for
// vague, round-about auto-generated videos: facts are the centre of every video (user rule 2026-07-09).
//
// SOURCES (free, no paid API): the seed article (a Radar candidate's `url`/`summary`) + a GDELT DOC 2.0
// keyword search for corroborating coverage. Each URL is fetched and stripped to text; the combined
// corpus is distilled by `claude -p` (keyless — it only summarizes the provided text, no web tools) into
// a strict-JSON FactSheet. Content-addressed cache (skip-if-exists) so a re-run replays the same facts.
// Every network step degrades gracefully → a best-effort sheet, never a crash.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PROJECT_ROOT, runClaudeText, extractJson } from './claude.js';

/** A place the story touches — with coordinates when geography matters (drives an optional map beat). */
export interface FactPlace {
  place: string;
  lat?: number;
  lon?: number;
  note?: string;
}

/** The distilled facts of a story. The Story Architect grounds EVERY beat in these — no invented filler. */
export interface FactSheet {
  topic: string;
  /** One-line what-happened. */
  headline: string;
  /** 2-4 sentence factual summary. */
  summary: string;
  when: string;
  where: FactPlace[];
  who: string[];
  /** Concrete figures: casualties, dates, amounts, counts — each with a label. */
  keyNumbers: Array<{ label: string; value: string }>;
  /** Specific events with specifics (not generalities). */
  incidents: string[];
  /** CHRONOLOGY (oldest → newest): the dated events that give the story its arc/origins, when history
   *  helps tell it coherently. Empty for a story where chronology adds nothing (a one-off event). */
  timeline: Array<{ when: string; event: string }>;
  /** Publisher names or URLs the facts came from. */
  sources: string[];
  /** Does geography genuinely help tell THIS story (locations/borders/spread/routes)? */
  needsMap: boolean;
  /** If needsMap: the countries to highlight on the world-in map. */
  mapCountries: string[];
  /** Specific stock-footage search phrases grounded in the facts (NOT generic terms). */
  footageHints: string[];
  /** REAL-IMAGE subjects that likely have a Wikimedia/Wikipedia photo — named people, specific places,
   *  buildings, events, operations (e.g. "Baitullah Mehsud", "Army Public School Peshawar"). Used for
   *  hard-news subjects stock footage never carries; the exact Wikipedia-style name is best. */
  imageSubjects: string[];
  /** An optional DATA-VIZ series when the story has an honest quantitative comparison/ranking/trend the
   *  sources support (a country ranking, a metric over years, a breakdown). The architect renders it as
   *  ONE chart beat: 'bar' for a ranking/comparison, 'line' for a time trend. Empty (data:[]) when the
   *  story has no chartable data OR you'd have to fabricate the numbers. `emphasis` = the subject label
   *  (drawn in the accent color). This is what makes a STATISTIC the hero visual instead of vague footage. */
  chart?: {
    kind: 'bar' | 'line';
    title: string;
    unit?: string;
    data: Array<{ label: string; value: number }>;
    emphasis?: string;
  };
  /** The REAL source-article URLs the facts came from (the ORIGINAL resources, in credibility order).
   *  The architect screenshots one as on-screen EVIDENCE for a data/report story — the actual article/
   *  chart, which is more credible than a reconstruction. Populated in code from URLs that yielded text. */
  sourceUrls: string[];
  /** How well-sourced this is: 'sourced' (real articles fetched) | 'thin' (little/no source text). */
  confidence: 'sourced' | 'thin';
}

export const PROMPT_VERSION = 'research@4';
const MAX_CORPUS = 14000;

/** Fetch a URL and strip it to readable text (best-effort; '' on any failure). */
async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; IndiaStoryboardBot/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return '';
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000);
  } catch {
    return '';
  }
}

/** GDELT DOC 2.0 keyword search → recent article {url,title} (free, no key). Empty on failure/throttle. */
async function gdeltSearch(query: string, max = 5): Promise<Array<{ url: string; title: string }>> {
  try {
    const u =
      `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}` +
      `&mode=ArtList&format=json&maxrecords=${max}&sort=DateDesc&timespan=21days`;
    const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
    const t = await res.text();
    if (!t.trim().startsWith('{')) return []; // throttle notice / HTML → nothing usable
    const j = JSON.parse(t) as { articles?: Array<{ url: string; title: string }> };
    return (j.articles ?? []).filter((a) => a.url && a.title).slice(0, max);
  } catch {
    return [];
  }
}

const SYSTEM = `You are the RESEARCH DESK of a news channel. Distill the SOURCE MATERIAL below into a STRICT
JSON fact sheet. Output ONLY the JSON object — no prose, no markdown.

RULES:
- Use ONLY facts supported by the source material. Do NOT invent numbers, names, dates, or places. If a
  field is unknown from the sources, use an empty string / empty array — never guess.
- Be SPECIFIC and CONCRETE: exact places, dates, names, and figures. This fact sheet is the SOLE basis for
  the video's narration, so vagueness here = a vague video.
- \`where\`: the real locations the story touches. Include lat/lon (decimal, approximate is fine) ONLY for
  well-known places you are confident about; omit them otherwise.
- \`keyNumbers\`: every concrete figure in the story (deaths, injured, dates, amounts, counts) as
  {label, value}.
- \`incidents\`: the specific events, each with its own specifics (place + what + number), not generalities.
- \`timeline\`: the KEY DATED events OLDEST→NEWEST that give the story its arc/origins — fill this whenever
  history helps explain how things got here (a conflict's roots, an escalation), so the video can walk a
  clear chronology; leave EMPTY for a one-off event where history adds nothing.
- \`needsMap\`: true ONLY if geography genuinely helps tell THIS story (locations, borders, spread, a route,
  which countries) — false for an abstract/policy/economic topic where a map adds nothing.
- \`mapCountries\`: if needsMap, the country names to highlight (English, e.g. "Pakistan", "India", "China").
- \`footageHints\`: 4-6 SPECIFIC stock-footage search phrases grounded in the facts (e.g. "pakistan army
  convoy", "border security patrol", "bomb blast aftermath street") — never generic ("war", "conflict").
- \`imageSubjects\`: 3-8 REAL-IMAGE subjects that a WIKIMEDIA/WIKIPEDIA photo almost certainly exists for —
  named people, specific places/buildings, events, operations, weapons (e.g. "Baitullah Mehsud", "Army
  Public School Peshawar", "Operation Zarb-e-Azb"). Use the EXACT common Wikipedia-style name. These give
  real visuals for hard-news subjects that stock footage never carries. Empty if the topic has no such
  concrete named subjects.
- \`chart\`: if the story turns on a QUANTITATIVE comparison / RANKING / TREND the SOURCE MATERIAL gives
  real numbers for (a ranking of countries, a metric over years, a breakdown into parts), fill \`chart\`
  with those ACTUAL figures so the video can show the DATA as its hero visual. kind:"bar" for a ranking/
  comparison/breakdown, kind:"line" for a time trend. 3-6 datapoints {label, value} — values are the REAL
  numbers from the sources, NEVER invented (no real numbers → leave data:[]). \`emphasis\` = the subject's
  label; \`unit\` = what the values measure ("attacks","deaths","GTI score"). Omit for a non-quantitative story.
- \`confidence\`: "sourced" if the SOURCE MATERIAL contained real reporting; "thin" if it was sparse/empty.

SHAPE (all keys required):
{"topic":"","headline":"","summary":"","when":"","where":[{"place":"","lat":0,"lon":0,"note":""}],
 "who":[""],"keyNumbers":[{"label":"","value":""}],"incidents":[""],
 "timeline":[{"when":"","event":""}],"sources":[""],
 "needsMap":false,"mapCountries":[""],"footageHints":[""],"imageSubjects":[""],
 "chart":{"kind":"bar","title":"","unit":"","emphasis":"","data":[{"label":"","value":0}]},
 "confidence":"sourced"}`;

export interface ResearchOptions {
  sourceUrl?: string;
  sourceSummary?: string;
  lang?: string;
}

/** Gather + distill the facts for a topic. Cached content-addressed; best-effort, never throws. */
export async function research(brief: string, opts: ResearchOptions = {}): Promise<FactSheet> {
  const cacheDir = resolve(PROJECT_ROOT, '.cache/agents/research');
  const key = createHash('sha256')
    .update(PROMPT_VERSION + '\n' + brief + '\n' + (opts.sourceUrl ?? ''))
    .digest('hex')
    .slice(0, 16);
  const cacheFile = resolve(cacheDir, `${key}.json`);
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8')) as FactSheet;

  // 1. Gather a source corpus: the seed article + a few GDELT-found corroborating pieces. Track which
  //    URLs actually yielded text — these are the REAL original resources the architect can screenshot.
  const parts: string[] = [];
  const sourceUrls: string[] = [];
  if (opts.sourceSummary) parts.push(`SEED SUMMARY: ${opts.sourceSummary}`);
  if (opts.sourceUrl) {
    const t = await fetchText(opts.sourceUrl);
    if (t) {
      parts.push(`SEED ARTICLE (${opts.sourceUrl}): ${t}`);
      sourceUrls.push(opts.sourceUrl);
    }
  }
  const related = await gdeltSearch(brief, 6);
  for (const r of related.slice(0, 3)) {
    const t = await fetchText(r.url);
    if (t) {
      parts.push(`ARTICLE — ${r.title} (${r.url}): ${t}`);
      sourceUrls.push(r.url);
    }
  }
  const corpus = parts.join('\n\n').slice(0, MAX_CORPUS);
  const haveSources = corpus.length > 200;

  // 2. Distill to a strict-JSON fact sheet via claude -p (keyless; only summarizes the provided corpus).
  const prompt =
    `${SYSTEM}\n\nTOPIC: ${brief}\n\nSOURCE MATERIAL:\n` +
    (haveSources ? corpus : '(No source text could be fetched. Fill only what is WIDELY and reliably known about this exact topic; set confidence to "thin" and leave anything uncertain empty.)');

  let sheet: FactSheet;
  try {
    sheet = extractJson(await runClaudeText(prompt)) as FactSheet;
    sheet.topic ||= brief;
    if (!haveSources) sheet.confidence = 'thin';
  } catch {
    sheet = {
      topic: brief,
      headline: opts.sourceSummary ?? brief,
      summary: opts.sourceSummary ?? '',
      when: '',
      where: [],
      who: [],
      keyNumbers: [],
      incidents: [],
      timeline: [],
      sources: [],
      needsMap: false,
      mapCountries: [],
      footageHints: [],
      imageSubjects: [],
      sourceUrls: [],
      confidence: 'thin',
    };
  }
  // The real original resources are known in CODE (the URLs that yielded text) — attach them for the
  // architect to screenshot as on-screen evidence. More reliable than asking the LLM to recall URLs.
  sheet.sourceUrls = sourceUrls;

  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(sheet, null, 2) + '\n', 'utf8');
  return sheet;
}
