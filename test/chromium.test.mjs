import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { chromiumManifest } from '../scripts/build-chromium.mjs';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));

test('Chromium manifest uses a service worker, raster icons and the same permissions', () => {
  const before = structuredClone(manifest);
  const chromium = chromiumManifest(manifest);
  assert.deepEqual(chromium.background, { service_worker: 'src/cache.js' });
  assert.equal(chromium.browser_specific_settings, undefined);
  assert.equal(chromium.minimum_chrome_version, '102');
  assert.deepEqual(chromium.permissions, manifest.permissions);
  assert.deepEqual(chromium.host_permissions, manifest.host_permissions);
  assert.deepEqual(chromium.content_scripts, manifest.content_scripts);
  assert.equal(chromium.version, manifest.version);
  for (const icon of [...Object.values(chromium.icons), ...Object.values(chromium.action.default_icon)]) {
    assert.ok(existsSync(resolve(root, 'safari', icon)));
    assert.match(icon, /\.png$/);
  }
  assert.deepEqual(manifest, before);
});

test('Chrome-only cache background replies asynchronously and rejects private senders', async () => {
  let listener;
  const saved = {};
  const chrome = {
    runtime: { onMessage: { addListener: fn => { listener = fn; } } },
    storage: { session: { get: async () => saved, set: async value => Object.assign(saved, value) } },
  };
  runInNewContext(readFileSync(resolve(root, 'src/cache.js'), 'utf8'), { chrome });
  const sender = { tab: { incognito: false }, url: 'https://www.youtube.com/watch?v=SmokeTest01' };
  async function send(message, from = sender) {
    let resolveResponse;
    const response = new Promise(resolve => { resolveResponse = resolve; });
    assert.equal(listener(message, from, resolveResponse), true);
    return response;
  }
  assert.equal(listener({ type: 'unrelated' }, sender, () => assert.fail()), undefined);
  assert.equal(await send({ type: 'youtube-exact-upload-date:cache-set', videoId: 'SmokeTest01', metadata: { date: '2026-09-22', kind: 'published' } }), true);
  const result = await send({ type: 'youtube-exact-upload-date:cache-get', videoId: 'SmokeTest01' });
  assert.equal(result.date, '2026-09-22');
  assert.equal(result.kind, 'published');
  assert.equal(await send({ type: 'youtube-exact-upload-date:cache-get', videoId: 'SmokeTest01' }, { ...sender, tab: { incognito: true } }), null);
  assert.equal(await send({ type: 'youtube-exact-upload-date:cache-get', videoId: 'SmokeTest01' }, { ...sender, url: 'https://example.com/' }), null);
});

test('Chrome-only content script loads preferences and answers status and retry messages', async () => {
  const dom = new JSDOM(`<ytd-video-renderer><a id="video-title" href="/watch?v=SmokeTest01">Fixture</a>
    <div id="metadata-line"><span class="inline-metadata-item" id="date">18 min ago</span></div></ytd-video-renderer>`, {
    url: 'https://www.youtube.com/results?search_query=fixture', runScripts: 'outside-only',
  });
  let listener;
  dom.window.chrome = {
    extension: { inIncognitoContext: false },
    runtime: {
      getManifest: () => ({ version: manifest.version }),
      sendMessage: async () => null,
      onMessage: { addListener: fn => { listener = fn; } },
    },
    storage: { local: { get: async () => ({ dateFormat: 'iso' }) } },
  };
  dom.window.fetch = async () => ({ ok: true, status: 200, text: async () => '<meta itemprop="datePublished" content="2026-09-22">' });
  try {
    dom.window.eval(readFileSync(resolve(root, 'src/content.js'), 'utf8'));
    async function send(type) {
      let resolveResponse;
      const response = new Promise(resolve => { resolveResponse = resolve; });
      assert.equal(listener({ type }, {}, resolveResponse), true);
      return response;
    }
    // Poll observable state instead of assuming jsdom scheduling latency.
    for (let attempt = 0; attempt < 50 && dom.window.document.querySelector('#date').textContent !== '2026-09-22'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(dom.window.document.querySelector('#date').textContent, '2026-09-22');
    const status = await send('youtube-exact-upload-date:status');
    assert.equal(status.version, manifest.version);
    assert.equal(status.replaced, 1);
    assert.equal((await send('youtube-exact-upload-date:retry')).retried, 0);
    assert.equal(listener({ type: 'unrelated' }, {}, () => assert.fail()), undefined);
  } finally { dom.window.close(); }
});
