# Publishing reels — `factory:publish`

Push a rendered project (`out.mp4` + its `project.json` `publish` block) to a distribution platform.
The layer is **extensible**: YouTube ships today; a new platform is one adapter (`src/publish/<name>.ts`
implementing `Publisher`) registered in `src/publish/index.ts` — the CLI names no platform.

**Safe by default:** the command is a **dry-run** (validates creds + metadata + file, uploads nothing)
until you pass `--yes`. Visibility defaults to **unlisted**.

```
npm run factory:publish -- <project>                        # dry-run preview (no upload)
npm run factory:publish -- <project> --auth                 # one-time OAuth consent
npm run factory:publish -- <project> --yes                  # upload as UNLISTED
npm run factory:publish -- <project> --yes --visibility public
npm run factory:publish -- <project> --platform youtube     # (default) choose platform(s), comma-sep
```

The title/description/tags/category/language come from the story's `publish:` block (compiled into
`project.json`). Edit them in `story.yaml` and re-render (or re-compile) to update.

---

## YouTube — one-time setup (free)

Uploads require OAuth 2.0 (an API key is not enough). Do this once:

1. **Google Cloud project** → console.cloud.google.com → create/select a project.
2. **Enable the API:** APIs & Services → Library → search "YouTube Data API v3" → **Enable**.
3. **OAuth consent screen:** APIs & Services → OAuth consent screen → External → fill the basics →
   add your Google account under **Test users** (so you can authorize while the app is unverified).
4. **Create credentials:** APIs & Services → Credentials → Create Credentials → **OAuth client ID** →
   Application type **Desktop app** → download the JSON.
5. **Give the CLI the client creds**, either:
   - `export YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=...`, or
   - save the downloaded file to `~/.config/animation-factory/youtube_client.json`.
6. **Authorize once:** `npm run factory:publish -- <project> --auth`
   A browser tab opens (loopback `http://127.0.0.1:8723`); approve. A refresh token is saved to
   `~/.config/animation-factory/youtube_token.json` (chmod 600). Done — no more prompts.

Then: `npm run factory:publish -- <project> --yes` uploads as unlisted and prints the link.

### ⚠️ The public-publish caveat

Until your OAuth app passes **Google's verification/audit**, the API **force-locks uploads to
private/unlisted** — requesting `--visibility public` may still land as unlisted. That's a Google
policy, not a bug. Options:
- **Recommended:** upload unlisted → glance in YouTube Studio → click **Publish** to go public. (Also
  the right safety default — a human eyeballs an outward-facing post before it's public.)
- Or submit the app for Google's OAuth verification + YouTube API compliance audit to unlock public.

### Quota
`videos.insert` costs 1600 units of the default 10,000/day → ~6 uploads/day free. More needs a quota
increase request in the Cloud console.

---

## Adding a platform (Instagram Reels / TikTok / X / webhook)

1. `src/publish/<platform>.ts` → a class `implements Publisher` (`platform`, `requires`, `isConfigured`,
   optional `authenticate`, `publish`). Map the generic `PublishMeta` onto that platform's API.
2. Register it in `src/publish/index.ts` (`registerPublisher(new <Platform>Publisher())`).
3. It's immediately usable: `factory:publish <project> --platform <name>`.

No CLI or core change — the registry resolves platforms by id, exactly like the render engine resolves
a provider by id.
