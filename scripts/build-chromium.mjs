// Derive Chromium's MV3 package from the Firefox source manifest.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');

export function chromiumManifest(manifest) {
  const result = structuredClone(manifest);
  delete result.browser_specific_settings;
  result.background = { service_worker: 'src/cache.js' };
  // Promise-based extension APIs and memory-only storage.session.
  result.minimum_chrome_version = '102';
  result.icons = Object.fromEntries([16, 32, 48, 128].map(size => [size, `icons/icon-${size}.png`]));
  result.action.default_icon = { 16: result.icons[16], 32: result.icons[32] };
  result.options_ui.open_in_tab = true;
  return result;
}

export function buildChromium(outDir = join(root, 'dist', 'chromium', 'extension')) {
  // Callers must supply an output folder inside this repository's dist directory.
  const output = resolve(outDir);
  const dist = join(root, 'dist');
  if (!output.startsWith(dist + '/') && !output.startsWith(dist + '\\')) {
    throw new Error('Chromium output must be inside dist');
  }
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const manifest = chromiumManifest(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')));
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  cpSync(join(root, 'src'), join(output, 'src'), { recursive: true });
  cpSync(join(root, 'safari', 'icons'), join(output, 'icons'), { recursive: true });
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Chromium extension files: ${buildChromium()}`);
}
