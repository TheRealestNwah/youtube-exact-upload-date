import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { safariManifest, SAFARI_MIN_VERSION } from "../scripts/build-safari.mjs";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const safari = safariManifest(manifest);

test("Safari manifest keeps the extension's permissions and content scripts", () => {
  assert.deepEqual(safari.permissions, manifest.permissions);
  assert.deepEqual(safari.host_permissions, manifest.host_permissions);
  assert.deepEqual(safari.content_scripts, manifest.content_scripts);
  assert.equal(safari.version, manifest.version);
});

test("Safari manifest drops Gecko settings and sets a Safari minimum", () => {
  assert.deepEqual(safari.browser_specific_settings, { safari: { strict_min_version: SAFARI_MIN_VERSION } });
});

test("Safari manifest keeps the background script and uses committed PNG icons", () => {
  assert.deepEqual(safari.background.scripts, manifest.background.scripts);
  const icons = [...Object.values(safari.icons), ...Object.values(safari.action.default_icon)];
  for (const icon of icons) {
    assert.match(icon, /^icons\/icon-\d+\.png$/);
    assert.ok(existsSync(resolve(root, "safari", icon)), `${icon} is missing from safari/icons`);
  }
});

test("Safari manifest does not modify the Firefox manifest", () => {
  assert.ok(manifest.browser_specific_settings.gecko);
});
