# Shared music beds (library/music/)

Reusable royalty-free music beds for reels + documentaries. Reference from a story:
`music: { ref: "library/music/<name>.mp3", gain: 0.5, duck: 0.3, fade: 16 }` or as a layered
`audio[]` track (per-act, crossfaded — see producing-documentaries).

The `.mp3` beds are gitignored (re-sourceable + kept out of the repo). Re-fetch from Incompetech and
**CREDIT "Kevin MacLeod (incompetech.com), CC-BY" in the video description**:

| file | Incompetech track | mood / use |
|---|---|---|
| ghost-story.mp3      | Ghost Story       | dark ambient — intro / death-zone / dread |
| the-descent.mp3      | The Descent       | sinking tension |
| anguish.mp3          | Anguish           | somber / loss |
| tension.mp3          | (tension bed)     | conflict / rising stakes |
| impact-prelude.mp3   | Impact Prelude    | building to a turn |
| heavy-interlude.mp3  | Heavy Interlude   | heavy mid-section |
| echoes-of-time-v2.mp3| Echoes of Time v2 | epic / reflective |
| long-note-two.mp3    | Long Note Two     | epic build — resolution / the payoff |

Fetch: `curl -L "https://incompetech.com/music/royalty-free/mp3-royaltyfree/<Track%20Name>.mp3" -o <name>.mp3`
then normalize: `ffmpeg -i in.mp3 -af loudnorm=I=-16:TP=-1.5:LRA=11 out.mp3`. (SFX beds are code recipes in
`src/cli/sfx.ts` → synthesized to `library/sfx/` on use; add new ones there.)
