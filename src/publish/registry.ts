// Publisher registry — the lookup table the CLI dispatches through. Platform id → Publisher. Adding a
// platform is `registerPublisher(new MyPlatformPublisher())` in index.ts; the CLI names no platform.

import type { Publisher } from './types.js';

const publishers = new Map<string, Publisher>();

export function registerPublisher(p: Publisher): void {
  publishers.set(p.platform, p);
}

export function getPublisher(platform: string): Publisher | undefined {
  return publishers.get(platform);
}

export function listPublishers(): Publisher[] {
  return [...publishers.values()];
}
