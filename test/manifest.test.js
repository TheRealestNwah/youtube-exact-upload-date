"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "..", "manifest.json"), "utf8"),
);

test("limits explicit host access to the content script's YouTube site", () => {
  assert.deepEqual(manifest.host_permissions, ["https://www.youtube.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions);
});

test("does not request unrelated extension permissions", () => {
  assert.deepEqual(manifest.permissions, ["storage"]);
});
