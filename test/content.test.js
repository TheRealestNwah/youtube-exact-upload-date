"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const {
  extractPublishedDate,
  extractVideoId,
  formatExactDate,
  isRelativeTime,
  normalizeCalendarDate,
  scanPage,
} = require("../src/content.js");

test("normalizes timestamps without shifting the calendar day", () => {
  assert.equal(
    normalizeCalendarDate("2026-09-22T23:59:59-07:00"),
    "2026-09-22",
  );
});

test("rejects impossible calendar dates", () => {
  assert.equal(normalizeCalendarDate("2026-02-29"), null);
  assert.equal(normalizeCalendarDate("not-a-date"), null);
});

test("accepts leap day in a leap year", () => {
  assert.equal(normalizeCalendarDate("2024-02-29"), "2024-02-29");
});

test("formats the requested exact date style", () => {
  assert.equal(formatExactDate("2026-09-22"), "Sept. 22 2026");
});

test("formats months with conventional abbreviations", () => {
  assert.equal(formatExactDate("2026-01-05"), "Jan. 5 2026");
  assert.equal(formatExactDate("2026-03-01"), "March 1 2026");
});

test("recognizes YouTube long relative timestamps", () => {
  assert.equal(isRelativeTime("1 day ago"), true);
  assert.equal(isRelativeTime("Streamed 2 years ago"), true);
  assert.equal(isRelativeTime("Premiered one month ago"), true);
});

test("recognizes YouTube compact relative timestamps", () => {
  assert.equal(isRelativeTime("8d ago"), true);
  assert.equal(isRelativeTime("9mo ago"), true);
});

test("does not mistake views or exact dates for relative timestamps", () => {
  assert.equal(isRelativeTime("647K views"), false);
  assert.equal(isRelativeTime("Sept. 22 2026"), false);
});

test("extracts video IDs from watch links", () => {
  assert.equal(
    extractVideoId("/watch?v=dQw4w9WgXcQ&list=abc"),
    "dQw4w9WgXcQ",
  );
});

test("extracts video IDs from Shorts and live links", () => {
  assert.equal(extractVideoId("/shorts/On2ZPIR5nuM"), "On2ZPIR5nuM");
  assert.equal(extractVideoId("/live/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});

test("rejects non-YouTube and malformed video links", () => {
  assert.equal(extractVideoId("https://example.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(extractVideoId("/watch?v=bad"), null);
});

test("extracts uploadDate metadata", () => {
  const html =
    '<html><head><meta itemprop="uploadDate" content="2026-09-22T18:30:00-04:00"></head></html>';
  assert.equal(extractPublishedDate(html), "2026-09-22");
});

test("extracts datePublished metadata regardless of attribute order", () => {
  const html =
    "<meta content='2009-10-24T23:57:33-07:00' itemprop='datePublished'>";
  assert.equal(extractPublishedDate(html), "2009-10-24");
});

test("falls back to serialized player data", () => {
  assert.equal(
    extractPublishedDate('{"publishDate":"2020-04-03"}'),
    "2020-04-03",
  );
});

test("returns null when HTML has no exact date", () => {
  assert.equal(extractPublishedDate("<html><body>1 day ago</body></html>"), null);
});

test("replaces the watch-page relative date with the embedded exact date", () => {
  const dom = new JSDOM(
    `<!doctype html>
      <meta itemprop="uploadDate" content="2026-09-22T23:59:59-07:00">
      <ytd-watch-info-text><div id="date-text">1 day ago</div></ytd-watch-info-text>`,
    { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
  );
  const originalLocation = globalThis.location;
  globalThis.location = dom.window.location;

  try {
    scanPage(dom.window.document);
    const date = dom.window.document.querySelector("#date-text");
    assert.equal(date.textContent, "Sept. 22 2026");
    assert.equal(date.getAttribute("aria-label"), "Uploaded Sept. 22 2026");
  } finally {
    globalThis.location = originalLocation;
  }
});

test("replaces a listing timestamp using its YouTube watch page", async () => {
  const dom = new JSDOM(
    `<!doctype html>
      <ytd-video-renderer>
        <a id="video-title" href="/watch?v=ApSiQXGQ7Fs">A video</a>
        <div id="metadata-line">
          <span class="inline-metadata-item">6.5K views</span>
          <span class="inline-metadata-item">8d ago</span>
        </div>
      </ytd-video-renderer>`,
    { url: "https://www.youtube.com/results?search_query=firefox" },
  );
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = dom.window.location;
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).searchParams.get("v"), "ApSiQXGQ7Fs");
    assert.equal(options.credentials, "omit");
    assert.equal(options.referrerPolicy, "no-referrer");
    return {
      ok: true,
      text: async () =>
        '<meta itemprop="uploadDate" content="2026-09-15T12:00:00Z">',
    };
  };

  try {
    scanPage(dom.window.document);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const items = dom.window.document.querySelectorAll(
      "#metadata-line .inline-metadata-item",
    );
    assert.equal(items[0].textContent, "6.5K views");
    assert.equal(items[1].textContent, "Sept. 15 2026");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
  }
});

test("replaces the Watch Later playlist timestamp", async () => {
  const dom = new JSDOM(
    `<!doctype html>
      <ytd-playlist-video-renderer>
        <a id="video-title" href="/watch?v=WLVideo1234&list=WL&index=1">
          A saved video
        </a>
        <div id="video-info">
          <span>Creator</span>
          <span>42K views</span>
          <span>2 days ago</span>
        </div>
      </ytd-playlist-video-renderer>`,
    { url: "https://www.youtube.com/playlist?list=WL" },
  );
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = dom.window.location;
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).searchParams.get("v"), "WLVideo1234");
    return {
      ok: true,
      text: async () =>
        '<meta itemprop="uploadDate" content="2026-09-21T08:00:00Z">',
    };
  };

  try {
    scanPage(dom.window.document);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const items = dom.window.document.querySelectorAll("#video-info span");
    assert.equal(items[0].textContent, "Creator");
    assert.equal(items[1].textContent, "42K views");
    assert.equal(items[2].textContent, "Sept. 21 2026");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
  }
});
