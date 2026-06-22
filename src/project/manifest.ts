// Project manifest — the descriptor for one video PROJECT (the reproducible unit that the engine
// renders). Convention follows the open bundle standards we surveyed: a root manifest + a timeline
// doc + organized media, in a working DIRECTORY form (cf. OpenTimelineIO `.otiod`) that can later be
// zipped for sharing (cf. dotLottie `.lottie` / OTIO `.otioz`). package.json/lockfile-style deps.
//
// A project CONSUMES the shared library (library : project :: npm package : app). `scene.json` is the
// deterministic compiled timeline (the engine's actual input); `project.lock` pins the library deps
// so a re-render is byte-identical even if the library later changes. `scene_ir_hash` content-
// addresses the timeline (skip-if-unchanged + provenance). Timestamps live here (metadata) and NEVER
// in scene.json, so renders stay deterministic.

import { z } from 'zod';

export const ProjectManifestSchema = z
  .object({
    project_version: z.string().default('1.0'),
    id: z.string().min(1),
    name: z.string().min(1),
    /** ISO timestamp the project was created/last compiled (metadata only; not a render input). */
    created: z.string().optional(),
    updated: z.string().optional(),
    /** Frame config, mirrored from the compiled Scene IR for quick inspection. */
    config: z.object({ w: z.number(), h: z.number(), fps: z.number(), duration_frames: z.number() }).strict(),
    /** Relative paths inside the project bundle. */
    source: z.string().default('story.yaml'),
    scene: z.string().default('scene.json'),
    lock: z.string().default('project.lock'),
    /** Content hash of scene.json (reproducibility / skip-if-unchanged). */
    scene_ir_hash: z.string(),
    /** Engine identity the project was rendered with (e.g. "remotion@4.0.481"). */
    engine: z.string(),
    /** Library deps this project pins (name@version refs; hashes live in project.lock). */
    deps: z.array(z.string()).default([]),
    /** Source artifacts VENDORED into the bundle (relative paths under assets/) so the project is
     *  self-contained and renders without the shared library (cf. OTIO .otiod media copy). */
    assets: z.array(z.string()).default([]),
    /** Generated outputs (relative paths under the project; gitignored on disk). */
    outputs: z
      .object({ video: z.string().optional(), thumbnail: z.string().optional() })
      .strict()
      .default({}),
  })
  .strict();

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export function parseManifest(data: unknown): ProjectManifest {
  return ProjectManifestSchema.parse(data);
}
