// News Radar — the notify unit. Turns a judged Candidate into an outbound ping so the operator can jump
// to the studio inbox and approve a build. One Notifier per channel (see RadarConfig.notify.channel);
// makeNotifier picks the impl. CONTRACT: send() NEVER throws — a notify failure must not break the daemon
// loop, so every impl logs + swallows. (This is a live service, not a render — Date.now() is fine.)
import { execFile } from 'node:child_process';

import type { Candidate, Notifier, RadarConfig } from './types.js';

// --- shared message formatting (pure) -----------------------------------------------------------

/** A coarse urgency emoji from the AI opportunity score (higher = hotter). */
function scoreEmoji(aiScore: number): string {
  if (aiScore >= 90) return '🔥';
  if (aiScore >= 80) return '🚀';
  if (aiScore >= 70) return '⭐';
  if (aiScore >= 55) return '👀';
  return '📄';
}

/** Human "age" of the item from its publish/seen time → "3m" / "2h" / "1d". */
function ageLabel(c: Candidate): string {
  const ms = Date.now() - (c.publishedAt ?? c.seenAt);
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

/** The concise notification body shared by Telegram/desktop: emoji+score, headline, whyIndia, source, age. */
function formatMessage(c: Candidate): string {
  return [
    `${scoreEmoji(c.aiScore)} ${c.aiScore} · ${c.title}`,
    c.whyIndia,
    `${c.source} · ${ageLabel(c)} ago`,
    'Approve in studio: http://127.0.0.1:5055/#radar',
  ].join('\n');
}

// --- telegram -----------------------------------------------------------------------------------

/**
 * Bot-API notifier. Reads TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (falling back to the OPENCLAW_* variants
 * that the local openclaw install exports). Missing creds → warn ONCE then no-op, so an unconfigured box
 * degrades to silence instead of crash-looping.
 */
class TelegramNotifier implements Notifier {
  readonly id = 'telegram';
  private readonly token = process.env['TELEGRAM_BOT_TOKEN'] ?? process.env['OPENCLAW_BOT_TOKEN'];
  private readonly chatId = process.env['TELEGRAM_CHAT_ID'] ?? process.env['OPENCLAW_CHAT_ID'];
  private warned = false;

  async send(candidate: Candidate): Promise<void> {
    if (!this.token || !this.chatId) {
      if (!this.warned) {
        this.warned = true; // one line, not one per candidate
        console.warn('[notify] telegram disabled: set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (or OPENCLAW_*)');
      }
      return;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: formatMessage(candidate),
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        // Telegram puts the reason in the body; keep it short. Log, don't throw (never break the loop).
        console.warn(`[notify] telegram sendMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (e) {
      console.warn(`[notify] telegram send failed: ${(e as Error).message}`);
    }
  }
}

// --- desktop ------------------------------------------------------------------------------------

/** libnotify (`notify-send`) desktop toast. Headless boxes have no notify-send → swallow the error. */
class DesktopNotifier implements Notifier {
  readonly id = 'desktop';

  send(candidate: Candidate): Promise<void> {
    const title = `${scoreEmoji(candidate.aiScore)} Radar ${candidate.aiScore} · ${candidate.source}`;
    const body = `${candidate.title}\n${candidate.whyIndia}`;
    return new Promise((resolve) => {
      execFile('notify-send', [title, body], (err) => {
        if (err) console.warn(`[notify] notify-send failed: ${err.message}`);
        resolve(); // always resolve — a missing binary is not a daemon-level failure
      });
    });
  }
}

// --- passive channels ---------------------------------------------------------------------------

/** No push: the studio polls the shortlist itself, so send() is a pure no-op. */
class NoopNotifier implements Notifier {
  constructor(readonly id: string) {}
  async send(_candidate: Candidate): Promise<void> {
    // intentionally nothing
  }
}

// --- factory ------------------------------------------------------------------------------------

/** Pick a Notifier from config. Unknown channels fall through to a safe no-op. */
export function makeNotifier(cfg: RadarConfig): Notifier {
  switch (cfg.notify.channel) {
    case 'telegram':
      return new TelegramNotifier();
    case 'desktop':
      return new DesktopNotifier();
    case 'studioBadge':
      return new NoopNotifier('studioBadge');
    case 'none':
    default:
      return new NoopNotifier('none');
  }
}
