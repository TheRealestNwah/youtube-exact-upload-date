"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");
const source = readFileSync(require.resolve("../src/content.js"), "utf8");

function fixture({ cached = null, privateWindow = false, fetch, dateFormat = "classic", displayMode = "exact" } = {}) {
  const dom = new JSDOM('<yt-lockup-view-model><a href="/watch?v=LoadingVid1">Video</a><yt-content-metadata-view-model><span aria-label="3 hours ago">3h ago</span></yt-content-metadata-view-model></yt-lockup-view-model>', {
    url: "https://www.youtube.com/", runScripts: "outside-only",
  });
  const messages = [];
  let listener;
  let storageListener;
  dom.window.browser = {
    extension: { inIncognitoContext: privateWindow },
    runtime: {
      getManifest: () => ({ version: "1.0.3" }),
      onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: async message => { messages.push(message); return message.type.endsWith("cache-get") ? cached : true; },
    },
    storage: {
      local: { get: async () => ({ dateFormat, displayMode }) },
      onChanged: { addListener: fn => { storageListener = fn; } },
    },
  };
  dom.window.fetch = fetch ?? (() => assert.fail("cached date must not fetch"));
  return { dom, messages, start: () => dom.window.eval(source),
    changeFormat: value => storageListener({ dateFormat: { newValue: value } }, "local"),
    changeDisplay: value => storageListener({ displayMode: { newValue: value } }, "local"),
    report: () => listener({ type: "youtube-exact-upload-date:status" }),
    span: dom.window.document.querySelector("span") };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

test("warm session cache replaces dates without a watch request", async () => {
  const f = fixture({ cached: "2026-09-23" });
  try {
    f.start();
    await tick();
    assert.equal(f.span.textContent, "Sept. 23 2026");
    const report = await f.report();
    assert.equal(report.requests, 0);
    assert.equal(report.sessionCacheHits, 1);
    assert.equal(f.span.hasAttribute("data-youtube-exact-upload-date-loading"), false);
  } finally { f.dom.window.close(); }
});

test("changing date format updates dates already shown on a card", async () => {
  const f = fixture({ cached: "2026-09-23" });
  try {
    f.start();
    await tick();
    f.changeFormat("iso");
    assert.equal(f.span.textContent, "2026-09-23");
    assert.equal(f.span.getAttribute("aria-label"), "Uploaded 2026-09-23");
    const report = await f.report();
    assert.equal(report.requests, 0);
  } finally { f.dom.window.close(); }
});

test("combined display preserves the original relative time and updates accessibility", async () => {
  const f = fixture({ cached: "2026-09-23", displayMode: "both" });
  try {
    f.start();
    await tick();
    assert.equal(f.span.textContent, "Sept. 23 2026 · 3h ago");
    assert.equal(f.span.getAttribute("aria-label"), "Uploaded Sept. 23 2026; 3h ago");
    f.changeDisplay("exact");
    assert.equal(f.span.textContent, "Sept. 23 2026");
    f.changeDisplay("both");
    assert.equal(f.span.textContent, "Sept. 23 2026 · 3h ago");
  } finally { f.dom.window.close(); }
});

test("failed fetch restores the untouched relative text and accessibility state", async () => {
  let finish;
  const f = fixture({ fetch: () => new Promise(resolve => { finish = resolve; }) });
  try {
    f.start();
    await tick();
    assert.equal(f.span.hasAttribute("data-youtube-exact-upload-date-loading"), true);
    assert.equal(f.span.getAttribute("aria-busy"), "true");
    finish({ ok: false, status: 503 });
    await tick();
    assert.equal(f.span.textContent, "3h ago");
    assert.equal(f.span.getAttribute("aria-label"), "3 hours ago");
    assert.equal(f.span.hasAttribute("aria-busy"), false);
    assert.equal(f.span.hasAttribute("data-youtube-exact-upload-date-loading"), false);
  } finally { f.dom.window.close(); }
});

test("placeholder times out even when the request never settles", async () => {
  const f = fixture({ fetch: () => new Promise(() => {}) });
  const originalTimer = f.dom.window.setTimeout.bind(f.dom.window);
  f.dom.window.setTimeout = (fn, delay) => originalTimer(fn, delay === 1800 ? 25 : delay);
  try {
    f.start();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(f.span.textContent, "3h ago");
    assert.equal(f.span.hasAttribute("data-youtube-exact-upload-date-loading"), false);
    assert.equal(f.span.hasAttribute("aria-busy"), false);
  } finally { f.dom.window.close(); }
});

test("private-window lookups neither read nor write shared dates", async () => {
  const f = fixture({ privateWindow: true, fetch: async () => ({ ok: true, status: 200,
    text: async () => '<meta itemprop="uploadDate" content="2026-09-23">' }) });
  try {
    f.start();
    await tick();
    assert.equal(f.span.textContent, "Sept. 23 2026");
    assert.equal(f.messages.length, 0);
  } finally { f.dom.window.close(); }
});

test("an old request cannot erase a recycled card's new loading state", async () => {
  const finish = [];
  const f = fixture({ fetch: () => new Promise(resolve => finish.push(resolve)) });
  try {
    f.start();
    await tick();
    f.dom.window.document.querySelector("a").setAttribute("href", "/watch?v=LoadingVid2");
    f.dom.window.document.dispatchEvent(new f.dom.window.Event("yt-navigate-finish"));
    await new Promise(resolve => setTimeout(resolve, 40));
    finish[0]({ ok: false, status: 503 });
    await tick();
    assert.equal(f.span.dataset.youtubeExactUploadDateLoading, "LoadingVid2");
    finish[1]({ ok: true, status: 200, text: async () => '<meta itemprop="uploadDate" content="2026-09-22">' });
    await tick();
    assert.equal(f.span.textContent, "Sept. 22 2026");
  } finally { f.dom.window.close(); }
});

test("a wide uncached Home row starts eight bounded lookups together", async () => {
  const cards = Array.from({ length: 16 }, (_, index) =>
    `<yt-lockup-view-model><a href="/watch?v=WideCard${String(index).padStart(4, "0")}">Video</a>` +
    '<yt-content-metadata-view-model><span aria-label="3 hours ago">3h ago</span></yt-content-metadata-view-model></yt-lockup-view-model>',
  ).join("");
  const dom = new JSDOM(cards, {
    url: "https://www.youtube.com/", runScripts: "outside-only",
  });
  const pending = [];
  let active = 0;
  let peak = 0;
  dom.window.browser = { extension: { inIncognitoContext: false }, runtime: {
    getManifest: () => ({ version: "1.0.4" }),
    onMessage: { addListener: () => {} },
    sendMessage: async () => null,
  } };
  dom.window.fetch = () => new Promise(resolve => {
    active += 1;
    peak = Math.max(peak, active);
    pending.push(() => {
      active -= 1;
      resolve({ ok: true, status: 200, text: async () => '<meta itemprop="uploadDate" content="2026-09-23">' });
    });
  });
  try {
    dom.window.eval(source);
    await tick();
    assert.equal(pending.length, 8);
    assert.equal(peak, 8);
    pending.slice(0, 8).forEach(finish => finish());
    await tick();
    assert.equal(pending.length, 16);
    assert.equal(peak, 8);
    pending.slice(8).forEach(finish => finish());
    await tick();
    assert.equal([...dom.window.document.querySelectorAll("yt-content-metadata-view-model span")]
      .filter(element => element.textContent === "Sept. 23 2026").length, 16);
  } finally { dom.window.close(); }
});
