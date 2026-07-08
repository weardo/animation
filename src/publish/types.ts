// Publisher layer — the EXTENSIBLE seam for pushing a finished reel to a distribution platform.
//
// A rendered project (out.mp4 + the project.json `publish` metadata block) is platform-AGNOSTIC. Each
// platform (YouTube today; Instagram Reels / TikTok / X later) is a `Publisher` that maps the generic
// `PublishMeta` onto its own upload API. The CLI (`factory:publish`) resolves the context once and
// dispatches to the named platform(s) — so adding a platform is a NEW ADAPTER, never a CLI rewrite
// (mirrors the engine's provider/generator registries: capability = a registered implementation).
//
// SAFETY: publishing is an OUTWARD-FACING side effect. Visibility defaults to `unlisted`; going public
// is explicit. `dryRun` validates everything (creds, metadata, file) WITHOUT calling the platform.

export type Visibility = 'private' | 'unlisted' | 'public';

/** Platform-agnostic upload metadata, resolved from the project.json `publish` block. */
export interface PublishMeta {
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  /** Human category name (e.g. "News & Politics"); each platform maps it to its own id/space. */
  category: string;
  /** BCP-47-ish default spoken/caption language ("hi", "hi-IN", "en"). */
  language?: string;
  madeForKids: boolean;
}

/** Everything a publisher needs for one upload. */
export interface PublishContext {
  /** Absolute path to the rendered video. */
  videoPath: string;
  /** Absolute path to a thumbnail image, if present. */
  thumbnailPath?: string;
  meta: PublishMeta;
  visibility: Visibility;
  /** Validate-only: resolve creds + metadata + file, but do NOT call the platform API. */
  dryRun: boolean;
  rootDir: string;
  projectDir: string;
  projectId: string;
}

export interface PublishResult {
  platform: string;
  status: 'uploaded' | 'dry-run' | 'skipped' | 'failed';
  /** Platform video id, when uploaded. */
  id?: string;
  /** Watch/Studio URL, when uploaded. */
  url?: string;
  visibility?: Visibility;
  /** Human-readable note (error text, dry-run summary, next-step hint). */
  message?: string;
}

/**
 * A distribution-platform adapter. Register one per platform. The generic CLI never names a platform —
 * it looks the publisher up by id, exactly like the render engine resolves a provider by id.
 */
export interface Publisher {
  /** Stable platform id, e.g. "youtube". */
  readonly platform: string;
  /** One-line human summary of the setup/creds this publisher needs (printed by the CLI). */
  readonly requires: string;
  /** Are credentials present + usable? (No network call.) */
  isConfigured(rootDir: string): boolean;
  /** OPTIONAL one-time interactive auth (e.g. an OAuth consent flow) that persists a token. */
  authenticate?(rootDir: string): Promise<void>;
  /** Upload the video. MUST honor `ctx.dryRun` (validate only) and `ctx.visibility`. */
  publish(ctx: PublishContext): Promise<PublishResult>;
}
