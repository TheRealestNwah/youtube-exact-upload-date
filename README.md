# Exact Upload Date for YouTube

A focused Firefox extension that replaces YouTube's relative upload times—such as `1d ago` or `2 years ago`—with clear dates such as `Sept. 22 2026`.

## What it does

- Updates dates on video watch pages.
- Updates video cards in search results, recommendations, the home feed, and other common listings.
- Keeps working as YouTube navigates and loads content without a full page refresh.
- Preserves the date published by YouTube instead of shifting it across time zones.
- Uses no analytics, account API access, or third-party service.
- Reuses exact dates across normal tabs and reloads during the current browser session.
- Offers the original English date format, ISO dates, or dates in the browser's language from the add-on settings page.
- Optionally shows the original relative time alongside the exact date.

The extension reads the exact date already embedded in watch pages. For listing cards, where YouTube provides only relative text, it fetches the corresponding public watch page from YouTube with at most eight requests running at once. Up to 500 successful video-ID/date pairs are cached in browser-session memory for six hours, shared across normal tabs and reloads. They are not written to disk or synced, and disappear when the browser session ends. Private windows use only their existing per-tab memory cache, never the shared cache.

New lookups briefly display an ellipsis in a reserved date-width space, then reveal the exact date. The original relative text returns on failure or after 1.8 seconds if the lookup is still pending. The short reveal animation respects reduced-motion preferences. New videos still require a network request; repeat visits can avoid it. The script starts at document start to reduce the initial flash of relative text, though YouTube's own rendering can still cause a brief flash. Version 1.0.4 allows up to eight concurrent lookups so a wide Home row can update in one wave, and searches watch-page markup for the date before parsing the whole HTML document.

## Install for development

1. Run `npm install`.
2. Open `about:debugging` in Firefox.
3. Choose **This Firefox**, then **Load Temporary Add-on**.
4. Select this repository's `manifest.json`.

Temporary add-ons disappear when Firefox closes. A permanent installation requires a signed build from Mozilla Add-ons.

After updating a temporary add-on, reload it in `about:debugging` and refresh the YouTube tab. Check the add-on's site-access permissions if it cannot run on YouTube. Private windows separately require **Run in Private Windows: Allow** in the add-on's settings.

## Develop and verify

### Troubleshooting a page that still shows relative dates

While the affected YouTube tab is active, open **Exact Upload Date for YouTube** from the browser's extensions button. Version 1.0.2 adds a local status panel. Copy its report to distinguish missing site access, a content script that did not respond, unmatched timestamps, failed requests, and responses without a parseable exact date. **Refresh status** only reads the counters; it does not reload the page or retry failed requests.

The report contains aggregate counters, HTTP status codes, and allowlisted error names only. It includes no URLs, video IDs, titles, cookies, or raw error messages; it is not stored or transmitted. Counters reset with the page. A connected script is not proof that replacement succeeded: check `replaced`, `datesFound`, and `sessionCacheHits`. Home, Subscriptions, and Watch Later were user-verified with 1.0.2. Version 1.0.3 adds session caching and smoother loading.

### Commands

```sh
npm test
npm run lint
npm run build
npm run test:firefox
npm run test:firefox:live
```

`npm run build` creates an unsigned ZIP in `web-ext-artifacts/`. Do not treat that ZIP as a permanently installable Firefox release; normal Firefox builds require Mozilla signing.

The Firefox tests use disposable profiles and the real content script. `test:firefox` uses a local fixture, checks loading styles, and reloads to verify that cached dates require zero watch requests; `test:firefox:live` verifies that dates actually change on YouTube search results and requires network access. Set `FIREFOX_BINARY` if Firefox is not in its default location. Test-only diagnostics go to a local loopback server and are not included in the packaged extension.

## Permissions and privacy

The extension runs only on `www.youtube.com`. It changes upload-date text and requests YouTube watch pages when it needs an exact date for a listing card. These same-site requests use the browser's existing YouTube cookies so that YouTube can return the page without a failing cross-site redirect. The extension does not read cookie values. Requests reveal the requested video IDs and ordinary connection information to YouTube, just like other YouTube page requests. The `storage` permission is used only for the memory-only session cache of video IDs, exact dates, and cache timestamps described above. No browsing history is saved to disk, no account details or cookies are cached, and nothing is sent to the extension author or any third party.

## AI-assisted development

OpenAI Codex assisted with code, tests, the icon, and documentation. The repository owner directed the product requirements and release decisions. The extension itself contains no AI features.

## License

[MIT](LICENSE)
