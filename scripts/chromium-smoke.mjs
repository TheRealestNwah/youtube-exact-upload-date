// Runs the packaged extension in an isolated Chromium profile with routed YouTube fixtures.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChromium } from './build-chromium.mjs';

const extension = buildChromium();
const profile = await mkdtemp(join(tmpdir(), 'youtube-date-chromium-'));
let context;
let requests = 0;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route('https://www.youtube.com/**', async route => {
    if (new URL(route.request().url()).pathname === '/watch') {
      requests++;
      assert.match(route.request().headers().cookie ?? '', /date-smoke=1/);
      await route.fulfill({ contentType: 'text/html', body: '<meta itemprop="datePublished" content="2026-09-22">' });
    } else {
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <ytd-video-renderer><a id="video-title" href="/watch?v=SmokeTest01">Fixture</a>
        <div id="metadata-line"><span class="inline-metadata-item" id="views">123 views</span>
        <span class="inline-metadata-item" id="date">18 min ago</span></div></ytd-video-renderer>` });
    }
  });
  await context.addCookies([{ name: 'date-smoke', value: '1', url: 'https://www.youtube.com', sameSite: 'Lax' }]);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/results?search_query=fixture');
  await page.waitForFunction(() => document.querySelector('#date')?.textContent === 'Sept. 22 2026');
  assert.equal(requests, 1);
  assert.equal(await page.locator('#views').textContent(), '123 views');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/src/status.html`);
  await page.bringToFront();
  const report = await popup.evaluate(() => readStatus(globalThis.browser ?? chrome));
  assert.equal(report.report.contentScript, 'connected');
  assert.equal(report.report.content.replaced, 1);

  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/options.html`);
  await options.selectOption('#date-format', 'iso');
  await page.waitForFunction(() => document.querySelector('#date')?.textContent === '2026-09-22');
  await options.selectOption('#display-mode', 'both');
  await page.waitForFunction(() => document.querySelector('#date')?.textContent.includes('18 min ago'));
  // Reload and a second tab must both reuse the background's session cache.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#date')?.textContent.startsWith('2026-09-22'));
  const second = await context.newPage();
  await second.goto('https://www.youtube.com/results?search_query=second');
  await second.waitForFunction(() => document.querySelector('#date')?.textContent.startsWith('2026-09-22'));
  assert.equal(requests, 1, 'warm reload and second tab must avoid watch requests');
  await second.bringToFront();
  const warm = await popup.evaluate(() => readStatus(globalThis.browser ?? chrome));
  assert.equal(warm.report.content.sessionCacheHits, 1);
  assert.equal(warm.report.content.requests, 0);
  console.log('Chromium smoke passed: dates, popup, preferences, session cache, reload and second tab.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
