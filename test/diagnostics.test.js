"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");
const { readStatus, retryFailedDates } = require("../src/status.js");
const source = readFileSync(require.resolve("../src/content.js"), "utf8");

test("content diagnostics distinguish failures and expose no video data", async (t) => {
  const cases = [
    ["success", async () => ({ ok: true, status: 200, redirected: true, text: async () => '<meta itemprop="uploadDate" content="2026-09-23">' }), { datesFound: 1, replaced: 1, redirects: 1 }],
    ["HTTP error", async () => ({ ok: false, status: 429 }), { httpErrors: 1, lastHttpStatus: 429, replaced: 0 }],
    ["date word without a date", async () => ({ ok: true, status: 200, text: async () => '<script>const uploadDate = null</script>' }), { missingDates: 1, datesFound: 0, replaced: 0 }],
    ["network error", async () => { throw new TypeError("https://private.example/?secret=SECRET"); }, { networkErrors: 1, lastError: "TypeError", replaced: 0 }],
  ];
  for (const [name, fetch, expected] of cases) {
    await t.test(name, async () => {
      const dom = new JSDOM(`<ytd-rich-item-renderer><yt-lockup-view-model><a href="/watch?v=PrivateVid1">PRIVATE TITLE</a><yt-content-metadata-view-model><span aria-label="3 hours ago">3h ago</span></yt-content-metadata-view-model></yt-lockup-view-model></ytd-rich-item-renderer>`, {
        url: "https://www.youtube.com/feed/subscriptions", runScripts: "outside-only",
      });
      let listener;
      dom.window.browser = { runtime: {
        getManifest: () => ({ version: "1.0.2" }),
        onMessage: { addListener: callback => { listener = callback; } },
      } };
      dom.window.fetch = fetch;
      try {
        dom.window.eval(source);
        await new Promise(resolve => setTimeout(resolve, 20));
        const report = await listener({ type: "youtube-exact-upload-date:status" });
        assert.equal(report.requests, 1);
        for (const [key, value] of Object.entries(expected)) assert.equal(report[key], value, key);
        assert.equal(listener({ type: "unrelated" }), undefined);
        assert.doesNotMatch(JSON.stringify(report), /PrivateVid|PRIVATE TITLE|SECRET|https:/);
      } finally { dom.window.close(); }
    });
  }
});

function mockApi({ siteAccess = true, response = { replaced: 3 }, retryResponse = { retried: 2 }, reject = false } = {}) {
  return {
    runtime: { getManifest: () => ({ version: "1.0.2" }) },
    permissions: { contains: async () => siteAccess },
    tabs: {
      query: async () => [{ id: 5 }],
      sendMessage: async (id, message) => {
        assert.equal(id, 5);
        if (reject) throw new Error("Private URL must not be exposed");
        if (message.type === "youtube-exact-upload-date:retry") return retryResponse;
        assert.equal(message.type, "youtube-exact-upload-date:status");
        return response;
      },
    },
  };
}

test("a startup scan error remains observable through the status listener", async () => {
  const dom = new JSDOM("<!doctype html>", {
    url: "https://www.youtube.com/", runScripts: "outside-only",
  });
  let listener;
  dom.window.browser = { runtime: {
    getManifest: () => ({ version: "1.0.2" }),
    onMessage: { addListener: callback => { listener = callback; } },
  } };
  const originalQuery = dom.window.document.querySelector;
  dom.window.document.querySelector = () => { throw new TypeError("private details"); };
  try {
    dom.window.eval(source);
    dom.window.document.querySelector = originalQuery;
    const report = await listener({ type: "youtube-exact-upload-date:status" });
    assert.equal(report.scanErrors, 1);
    assert.equal(report.lastError, "TypeError");
    assert.doesNotMatch(JSON.stringify(report), /private details/);
  } finally { dom.window.close(); }
});

test("retry clears failed lookups but keeps successful dates", async () => {
  const dom = new JSDOM(`<ytd-rich-item-renderer><a href="/watch?v=RetryVideo1">Video</a><div id="metadata-line"><span class="inline-metadata-item">3h ago</span></div></ytd-rich-item-renderer>`, {
    url: "https://www.youtube.com/", runScripts: "outside-only",
  });
  let listener;
  let requests = 0;
  dom.window.browser = { runtime: {
    getManifest: () => ({ version: "1.0.4" }),
    onMessage: { addListener: fn => { listener = fn; } },
  } };
  dom.window.fetch = async () => {
    requests += 1;
    return requests === 1 ? { ok: false, status: 503 } :
      { ok: true, status: 200, text: async () => '<meta itemprop="uploadDate" content="2026-09-23">' };
  };
  try {
    dom.window.eval(source);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await listener({ type: "youtube-exact-upload-date:status" })).failedLookups, 1);
    assert.equal((await listener({ type: "youtube-exact-upload-date:retry" })).retried, 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requests, 2);
    assert.equal(dom.window.document.querySelector("span").textContent, "Sept. 23 2026");
    assert.equal((await listener({ type: "youtube-exact-upload-date:retry" })).retried, 0);
  } finally { dom.window.close(); }
});

test("status detects a connected content script", async () => {
  const result = await readStatus(mockApi());
  assert.equal(result.report.contentScript, "connected");
  assert.equal(result.report.content.replaced, 3);
});

test("status identifies a missing site grant without messaging the page", async () => {
  const api = mockApi({ siteAccess: false });
  api.tabs.sendMessage = () => assert.fail("must not message without site access");
  const result = await readStatus(api);
  assert.equal(result.report.siteAccess, false);
  assert.match(result.summary, /access is off/);
});

test("status does not confuse a nonresponding script with successful execution", async () => {
  for (const options of [{ reject: true }, { response: null }]) {
    const result = await readStatus(mockApi(options));
    assert.equal(result.report.contentScript, "no response");
    assert.doesNotMatch(JSON.stringify(result), /Private URL/);
  }
});

test("retry action sends only to the active permitted tab", async () => {
  assert.equal(await retryFailedDates(mockApi()), 2);
  const api = mockApi({ siteAccess: false });
  api.tabs.sendMessage = () => assert.fail("must not message without site access");
  await assert.rejects(retryFailedDates(api), /access is off/);
});

test("popup displays the report and refreshes it without reloading the tab", async () => {
  const html = readFileSync(require.resolve("../src/status.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  dom.window.browser = mockApi();
  try {
    dom.window.eval(readFileSync(require.resolve("../src/status.js"), "utf8"));
    await new Promise(resolve => setTimeout(resolve, 10));
    const report = dom.window.document.querySelector("#report");
    assert.equal(JSON.parse(report.value).content.replaced, 3);
    dom.window.browser = mockApi({ response: { replaced: 8, failedLookups: 2 } });
    dom.window.document.querySelector("#refresh").click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(JSON.parse(report.value).content.replaced, 8);
    assert.equal(dom.window.document.querySelector("#refresh").disabled, false);
    const retry = dom.window.document.querySelector("#retry");
    assert.equal(retry.disabled, false);
    retry.click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(dom.window.document.querySelector("#summary").textContent, /Retrying dates for 2 failed videos/);
  } finally { dom.window.close(); }
});
