# Exact Upload Date for YouTube

A Firefox extension (`manifest.json`) that replaces YouTube's relative video dates with exact dates. The GitHub repo is `youtube-exact-upload-date`.

## Build, test, lint

Node 22 in CI, Node >= 20 required.

```bash
npm ci
npm run check               # unit tests + web-ext lint (what CI runs first)
npm test                    # node --test (jsdom)
npm run lint                # web-ext lint
npm run test:firefox        # headless Firefox smoke test (scripts/firefox-smoke.mjs); CI runs this too
npm run test:firefox:live   # same against live YouTube; run manually, not in CI
npm run build               # web-ext build -> web-ext-artifacts/
```

## Layout

- `src/content.js` / `content.css` — content script that rewrites dates on YouTube pages.
- `src/cache.js` — date cache. `src/options.*` and `src/status.*` — options and status pages.
- `manifest.json` — version is mirrored in `package.json`; `test/manifest.test.js` guards the manifest.
- `test/` — `node --test` suites using jsdom. `scripts/` — Firefox smoke runner.

## Gotchas

- Keep the `manifest.json` and `package.json` versions in step when releasing.
- `test/` and `scripts/` are excluded from lint and build via the `--ignore-files` lists in `package.json`; add new non-extension files there.
- The live smoke test depends on YouTube's current markup and can fail for reasons unrelated to a change.
