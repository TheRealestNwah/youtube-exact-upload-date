"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "..", "manifest.json"), "utf8"),
);

test("requests the YouTube host permission required by its content script", () => {
  assert.deepEqual(manifest.host_permissions, ["https://www.youtube.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions);
});

test("does not request unrelated extension permissions", () => {
  assert.equal(manifest.permissions, undefined);
});
