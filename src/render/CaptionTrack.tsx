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

  // Bottom-centre, readable: a semi-opaque dark pill behind light text (the standard subtitle look),
  // constrained to ~80% width so long lines wrap instead of bleeding to the edges.
  const wrapStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: Math.round(height * 0.06),
    display: 'flex',
    justifyContent: 'center',
    pointerEvents: 'none',
  };
  const pillStyle: React.CSSProperties = {
    maxWidth: Math.round(width * 0.8),
    padding: '0.35em 0.7em',
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.62)',
    color: '#ffffff',
    fontFamily: CAPTION_FONT,
    fontSize: Math.round(width / 36),
    fontWeight: 600,
    lineHeight: 1.25,
    textAlign: 'center',
    textShadow: '0 1px 2px rgba(0,0,0,0.6)',
    whiteSpace: 'pre-wrap',
  };

  return (
    <AbsoluteFill data-caption={cue.id}>
      <div style={wrapStyle}>
        <div style={pillStyle}>{text}</div>
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
