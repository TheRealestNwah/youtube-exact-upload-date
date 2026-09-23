// Runs the real content script in a disposable Firefox profile. No user profile
// or account is accessed. Test-only telemetry is sent to a loopback HTTP server.
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import webExt from 'web-ext';

const root = path.resolve(import.meta.dirname, '..');
const directory = await mkdtemp(path.join(tmpdir(), 'youtube-date-smoke-'));
const live = process.argv.includes('--live');
const minimumReplacements = live ? 3 : 2;
let finish;
const result = new Promise(resolve => { finish = resolve; });
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const report = JSON.parse(body);
    console.log(JSON.stringify(report));
    if ((report.replaced >= minimumReplacements && report.rounds >= 3 && report.valid) || report.final) finish(report);
    response.end('ok');
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  if (request.url.startsWith('/watch')) {
    if (!request.headers.cookie?.includes('date-smoke=1')) {
      response.writeHead(403);
      response.end('The watch-page fixture requires its same-site session cookie.');
      return;
    }
    response.end('<meta itemprop="uploadDate" content="2026-09-22T10:00:00Z">');
  } else {
    response.setHeader('Set-Cookie', 'date-smoke=1; SameSite=Lax; Path=/');
    response.end(`<!doctype html><ytd-video-renderer><a id="video-title" href="/watch?v=SmokeTest01">Test video</a><div id="metadata-line"><span class="inline-metadata-item" id="views">123 views</span><span class="inline-metadata-item">18 min ago</span></div></ytd-video-renderer>
      <script>setTimeout(() => {
        const card = document.createElement('ytd-playlist-video-renderer');
        card.innerHTML = '<a id="video-title" href="/watch?v=SmokeTest02">Later video</a><div id="video-info"><span>18 min ago</span></div>';
        document.body.append(card);
      }, 3000);</script>`);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
let runner;
let timeout;
try {
  await mkdir(path.join(directory, 'src'));
  let source = await readFile(path.join(root, 'src/content.js'), 'utf8');
  // Local fixture only: allow the production startup hostname guard to run.
  if (!live) source = source.replaceAll('youtube\\.com$', '127\\.0\\.0\\.1$|youtube\\.com$');
  await writeFile(path.join(directory, 'src/content.js'), source);
  await writeFile(path.join(directory, 'probe.js'), String.raw`
    let rounds = 0;
    const timer = setInterval(() => {
      const changed = [...document.querySelectorAll('[data-youtube-exact-upload-date]')];
      const local = location.hostname === '127.0.0.1';
      const valid = changed.every(element => local
        ? element.textContent === 'Sept. 22 2026'
        : /^[A-Z][a-z]+\.? \d{1,2} \d{4}$/.test(element.textContent))
        && (!local || document.querySelector('#views').textContent === '123 views');
      const report = {
        replaced: changed.length,
        privateWindow: browser.extension.inIncognitoContext,
        valid,
        pending: document.querySelectorAll('[data-youtube-exact-upload-date-pending]').length,
        rounds: ++rounds,
        final: rounds >= 15
      };
      browser.runtime.sendMessage(report);
      if (report.final) clearInterval(timer);
    }, 2000);
  `);
  await writeFile(path.join(directory, 'background.js'), `
    browser.runtime.onMessage.addListener(report => {
      return fetch('${endpoint}/report', { method: 'POST', body: JSON.stringify(report) }).then(() => {});
    });
  `);
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  delete manifest.icons;
  manifest.background = { scripts: ['background.js'] };
  manifest.host_permissions.push('http://127.0.0.1/*');
  manifest.content_scripts[0].js.push('probe.js');
  if (!live) manifest.content_scripts[0].matches.push('http://127.0.0.1/*');
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  timeout = setTimeout(() => finish({ error: 'No content-script report within 60 seconds' }), 60000);
  runner = await webExt.cmd.run({
    sourceDir: directory,
    firefox: process.env.FIREFOX_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : 'firefox'),
    args: ['-headless'],
    startUrl: [live ? 'https://www.youtube.com/results?search_query=firefox' : endpoint],
    noReload: true,
  }, { shouldExitProgram: false });
  const report = await result;
  if (report.replaced >= minimumReplacements && report.valid) {
    console.log('Firefox content-script smoke test passed.');
  } else {
    console.error(`Firefox date replacement failed: ${JSON.stringify(report)}`);
    process.exitCode = 1;
  }
} finally {
  clearTimeout(timeout);
  if (runner) await runner.exit();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
