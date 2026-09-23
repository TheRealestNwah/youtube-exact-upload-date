# Exact Upload Date for YouTube

A focused Firefox extension that replaces YouTube's relative upload times—such as `1d ago` or `2 years ago`—with clear dates such as `Sept. 22 2026`.

## What it does

- Updates dates on video watch pages.
- Updates video cards in search results, recommendations, the home feed, and other common listings.
- Keeps working as YouTube navigates and loads content without a full page refresh.
- Preserves the date published by YouTube instead of shifting it across time zones.
- Uses no analytics, account access, storage permission, or third-party service.

The extension reads the exact date already embedded in watch pages. For listing cards, where YouTube provides only relative text, it fetches the corresponding public watch page from YouTube with at most three requests running at once. Results are cached in memory for the life of the tab.

## Install for development

1. Run `npm install`.
2. Open `about:debugging` in Firefox.
3. Choose **This Firefox**, then **Load Temporary Add-on**.
4. Select this repository's `manifest.json`.

Temporary add-ons disappear when Firefox closes. A permanent installation requires a signed build from Mozilla Add-ons.

After updating a temporary add-on, reload it in `about:debugging` and refresh the YouTube tab. Check the add-on's site-access permissions if it cannot run on YouTube. Private windows separately require **Run in Private Windows: Allow** in the add-on's settings.

## Develop and verify

```sh
npm test
npm run lint
npm run build
npm run test:firefox
npm run test:firefox:live
```

`npm run build` creates an unsigned ZIP in `web-ext-artifacts/`. Do not treat that ZIP as a permanently installable Firefox release; normal Firefox builds require Mozilla signing.

The Firefox tests use disposable profiles and the real content script. `test:firefox` uses a local fixture; `test:firefox:live` verifies that dates actually change on YouTube search results and requires network access. Set `FIREFOX_BINARY` if Firefox is not in its default location. Test-only diagnostics go to a local loopback server and are not included in the packaged extension.

## Permissions and privacy

The extension runs only on `www.youtube.com`. It changes upload-date text and requests YouTube watch pages when it needs an exact date for a listing card. These same-site requests use the browser's existing YouTube cookies so that YouTube can return the page without a failing cross-site redirect. The extension does not read cookie values. Requests reveal the requested video IDs and ordinary connection information to YouTube, just like other YouTube page requests. The extension does not collect or store personal data, contact the extension author, or contact any third party.

## AI-assisted development

OpenAI Codex assisted with code, tests, the icon, and documentation. The repository owner directed the product requirements and release decisions. The extension itself contains no AI features.

## License

[MIT](LICENSE)
