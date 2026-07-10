// <CaptionTrack> — the compositor's renderer for narration-synced CAPTIONS (subtitles). Spec §11.3
// (narration-synced text) / §12 (captions). A GLOBAL-timeline visual track (parallel to the
// <NarrationTrack> audio track in Composition.tsx): each `SceneIR.captions[]` cue becomes a styled,
// readable caption inside a Remotion `<Sequence from={cue.at}>` so it appears exactly while its
// narration line plays.
//
// REUSE over invent (ADR-003): captions are plain styled DOM text in a Remotion `<Sequence>` — no
// new primitive. We deliberately DON'T pull `@remotion/captions` here: the cue text + window are
// already exact (we authored the `say` line), and the `words` reveal is a pure function of frame.
//
// WORD REVEAL (`words` mode), two paths:
//   • M4 PRECISE — when the cue carries `wordsTimed[]` (whisper forced-alignment, produced OFFLINE +
//     cached → deterministic), each word reveals at its REAL spoken LOCAL frame (`at`). The shown
//     count = how many words have a start `at <= local frame`.
//   • EVEN-SPLIT fallback — no `wordsTimed`: word i is shown once the local frame passes (i+1)/N of
//     the window (`floor` of an even split). Deterministic without whisper.
//
// DETERMINISM (CLAUDE.md r.1): a pure function of (cue, frame). No Date.now / Math.random; the font is
// the vendored local DejaVu Sans face the TextLayer already registers (shared @font-face cache). The
// `wordsTimed[]` timings come from a CACHED alignment JSON (the deterministic record), not a live run.

import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CaptionCue } from '../ir/index.js';
import { resolveFontUrl, useVendoredFont } from './TextLayer.js';

/**
 * The caption font STACK. A vendored Noto Sans Devanagari face (loaded below) is preferred so Indic
 * scripts (Hindi/Marathi/…) render real glyphs instead of tofu boxes; Latin/digits fall back to the
 * DejaVu Sans face the TextLayer registers, then the system sans-serif. Multilingual by construction:
 * the browser picks each glyph from the first family in the stack that has it. (Other Indic scripts —
 * Tamil/Telugu/… — want their own Noto face; generalizing the caption font to DATA is future work.)
 */
const CAPTION_FONT = '"Noto Sans Devanagari", "DejaVu Sans", sans-serif';

/** The vendored Devanagari face registered for captions (offline, deterministic — same pattern as text). */
const CAPTION_DEVANAGARI_FAMILY = 'Noto Sans Devanagari';
const CAPTION_DEVANAGARI_URI = 'asset://fonts/NotoSansDevanagari.ttf';

/** The default active-word highlight when a cue carries no brand `accent` (India Storyboard saffron). */
const DEFAULT_ACCENT = '#FA7A1E';

/**
 * Group words into short readable phrases (flow captions show ONE chunk at a time). A chunk ends at
 * sentence/clause punctuation (. , ! ? ; :) or once it reaches `maxWords`. Pure → deterministic. Returns
 * [start,end) index ranges over `words`.
 */
function chunkRanges(words: string[], maxWords = 6, minWords = 3): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const len = i - start + 1;
    const endsClause = /[.,!?;:—]$/.test(words[i] ?? '');
    // Break at a clause end only once the chunk has some heft (avoids a lone "Friends,"); always break at
    // maxWords or the final word.
    if ((endsClause && len >= minWords) || len >= maxWords || i === words.length - 1) {
      ranges.push([start, i + 1]);
      start = i + 1;
    }
  }
  if (ranges.length === 0) return [[0, words.length]];
  // Merge a short trailing chunk into the previous so the last phrase never dangles (e.g. "of 8.574.").
  const last = ranges[ranges.length - 1]!;
  if (ranges.length > 1 && last[1] - last[0] < minWords) {
    ranges[ranges.length - 2]![1] = last[1];
    ranges.pop();
  }
  return ranges;
}

/** One caption cue, rendered for its window. The `words` mode reveals tokens cumulatively even-split. */
const CaptionCueView: React.FC<{ cue: CaptionCue }> = ({ cue }) => {
  const frame = useCurrentFrame(); // LOCAL frame within the <Sequence> (0 at cue.at)
  const { width, height } = useVideoConfig();
  // Register + await the vendored Devanagari face (deterministic offline gate) so Indic captions paint
  // with real glyphs, not tofu. The @font-face injection is deduped; Latin still falls back to DejaVu.
  useVendoredFont(CAPTION_DEVANAGARI_FAMILY, resolveFontUrl(CAPTION_DEVANAGARI_URI));

  let text = cue.text;
  if (cue.mode === 'words') {
    if (cue.wordsTimed && cue.wordsTimed.length > 0) {
      // M4 PRECISE: reveal each word at its REAL spoken local frame. A word is shown once the local
      // frame reaches its start `at` (a deterministic step function of the frame). At least one word
      // shows from the start so the pill is never momentarily empty.
      const tw = cue.wordsTimed;
      let shown = 0;
      for (const w of tw) if (frame >= w.at) shown += 1;
      shown = Math.max(1, Math.min(tw.length, shown));
      text = tw.slice(0, shown).map((w) => w.w).join(' ');
    } else {
      const words = cue.words && cue.words.length > 0 ? cue.words : cue.text.split(/\s+/).filter(Boolean);
      if (words.length > 0) {
        // Even-split: word i is fully shown once the local frame passes (i+1)/N of the window. `floor`
        // makes the reveal a deterministic step function of the frame (no easing, no sub-pixel drift).
        const per = cue.duration_frames / words.length;
        const shown = Math.max(1, Math.min(words.length, Math.floor(frame / per) + 1));
        text = words.slice(0, shown).join(' ');
      }
    }
  }

  // FLOW (karaoke): show ONE rolling short phrase; highlight the currently-spoken word in the brand accent
  // (already-spoken words full-white, upcoming words dimmed). Reads along with the voice for a muted viewer.
  let flowNode: React.ReactNode = null;
  if (cue.mode === 'flow') {
    const words = cue.words && cue.words.length > 0 ? cue.words : cue.text.split(/\s+/).filter(Boolean);
    const accent = cue.accent ?? DEFAULT_ACCENT;
    // Active word (0-based): the last word whose start `at` <= local frame (deterministic step of frame).
    let active = 0;
    if (cue.wordsTimed && cue.wordsTimed.length > 0) {
      for (let i = 0; i < cue.wordsTimed.length; i++) if (frame >= cue.wordsTimed[i]!.at) active = i;
    } else if (words.length > 0) {
      active = Math.floor(frame / (cue.duration_frames / words.length));
    }
    active = Math.max(0, Math.min(words.length - 1, active));
    // The phrase (chunk) containing the active word — a rolling window, not the whole line.
    const range = chunkRanges(words).find(([s, e]) => active >= s && active < e) ?? [0, words.length];
    const [cs, ce] = range;
    flowNode = words.slice(cs, ce).map((w, k) => {
      const idx = cs + k;
      const isActive = idx === active;
      return (
        <span
          key={idx}
          style={{
            color: isActive ? accent : '#ffffff',
            opacity: idx <= active ? 1 : 0.45, // spoken = full, upcoming = dim
            fontWeight: isActive ? 800 : 600,
            margin: '0 0.14em',
          }}
        >
          {w}
        </span>
      );
    });
  }

  // Bottom-centre, readable: a semi-opaque dark pill behind light text (the standard subtitle look),
  // constrained to ~80% width so long lines wrap instead of bleeding to the edges.
  const wrapStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: Math.round(height * 0.16),
    display: 'flex',
    justifyContent: 'center',
    pointerEvents: 'none',
  };
  const pillStyle: React.CSSProperties = {
    maxWidth: Math.round(width * 0.8),
    padding: '0.35em 0.7em',
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.42)',
    color: '#ffffff',
    fontFamily: CAPTION_FONT,
    fontSize: Math.round(width / 28),
    fontWeight: 600,
    lineHeight: 1.25,
    textAlign: 'center',
    textShadow: '0 2px 6px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.9)',
    whiteSpace: 'pre-wrap',
  };

  return (
    <AbsoluteFill data-caption={cue.id}>
      <div style={wrapStyle}>
        <div style={pillStyle}>{cue.mode === 'flow' ? flowNode : text}</div>
      </div>
    </AbsoluteFill>
  );
};

/**
 * The full caption track: every `SceneIR.captions[]` cue placed at its global `at` in a `<Sequence>`.
 * Dropped by the caller on an alpha render (captions belong to the finished film, like narration).
 */
export const CaptionTrack: React.FC<{ captions: CaptionCue[] | undefined }> = ({ captions }) => (
  <>
    {(captions ?? []).map((cue) => (
      <Sequence
        key={cue.id}
        from={cue.at}
        durationInFrames={Math.max(1, cue.duration_frames)}
        layout="none"
      >
        <CaptionCueView cue={cue} />
      </Sequence>
    ))}
  </>
);

export default CaptionTrack;
