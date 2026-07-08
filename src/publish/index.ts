// Publisher wiring — register every platform adapter here. Adding a platform (Instagram Reels, TikTok,
// X/Twitter, a webhook, …) is: implement `Publisher` in ./<platform>.ts, import it, and register it
// below. Nothing else changes — the CLI resolves platforms by id through the registry.

import { registerPublisher, getPublisher, listPublishers } from './registry.js';
import { YouTubePublisher } from './youtube.js';

let wired = false;

/** Register all built-in publishers (idempotent). Call before using the registry. */
export function loadPublishers(): void {
  if (wired) return;
  registerPublisher(new YouTubePublisher());
  // FUTURE platforms register here, e.g.:
  //   registerPublisher(new InstagramReelsPublisher());
  //   registerPublisher(new TikTokPublisher());
  wired = true;
}

export { getPublisher, listPublishers, registerPublisher };
export type { Publisher, PublishContext, PublishResult, PublishMeta, Visibility } from './types.js';
