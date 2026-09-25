"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionDateCache, createCacheListener } = require("../src/cache.js");

function storage() {
  let saved = {};
  return {
    get: async () => structuredClone(saved),
    set: async data => { saved = structuredClone(data); },
  };
}

test("session cache survives background recreation and expires dates", async () => {
  const store = storage();
  let time = 1000;
  const cache = createSessionDateCache(store, () => time);
  assert.equal(await cache.get("CacheVideo1"), null);
  await cache.set("CacheVideo1", { date: "2026-09-23", kind: "published" });
  assert.deepEqual(await createSessionDateCache(store, () => time).get("CacheVideo1"),
    { date: "2026-09-23", kind: "published" });
  time += 6 * 60 * 60 * 1000;
  assert.equal(await cache.get("CacheVideo1"), null);
});

test("cache bounds entries and serializes concurrent writes", async () => {
  const store = storage();
  const cache = createSessionDateCache(store, () => 1000, 2);
  await Promise.all(["CacheVideo1", "CacheVideo2", "CacheVideo3"].map(id =>
    cache.set(id, { date: "2026-09-23", kind: "upload" })));
  const restarted = createSessionDateCache(store, () => 1000, 2);
  assert.equal(await restarted.get("CacheVideo1"), null);
  assert.deepEqual(await restarted.get("CacheVideo2"), { date: "2026-09-23", kind: "upload" });
  assert.deepEqual(await restarted.get("CacheVideo3"), { date: "2026-09-23", kind: "upload" });
});

test("invalid dates and video IDs never enter the cache", async () => {
  const cache = createSessionDateCache(storage());
  assert.equal(await cache.set("CacheVideo1", { date: "2026-02-30", kind: "upload" }), false);
  assert.equal(await cache.set("https://youtube.com", { date: "2026-09-23", kind: "upload" }), false);
  assert.equal(await cache.set("CacheVideo1", { date: "2026-09-23", kind: "unknown" }), false);
  assert.equal(await cache.get("CacheVideo1"), null);
});

test("private tabs and foreign senders cannot read or write the shared cache", async () => {
  const listener = createCacheListener({ get: () => assert.fail(), set: () => assert.fail() });
  for (const sender of [{ tab: { incognito: true }, url: "https://www.youtube.com/" }, { tab: {}, url: "https://evil.example/" }, {}]) {
    for (const operation of ["get", "set"]) {
      assert.equal(await listener({ type: `youtube-exact-upload-date:cache-${operation}` }, sender), null);
    }
  }
  assert.equal(listener({ type: "unrelated" }, {}), undefined);
});

test("cache storage failure degrades to a miss", async () => {
  const listener = createCacheListener(createSessionDateCache({ get: async () => { throw Error("unavailable"); } }));
  assert.equal(await listener({ type: "youtube-exact-upload-date:cache-get", videoId: "CacheVideo1" }, {
    tab: { incognito: false }, url: "https://www.youtube.com/",
  }), null);
});

test("older cached dates use a neutral label when their source is unknown", async () => {
  const store = storage();
  await store.set({ exactUploadDates: [["CacheVideo1", { date: "2026-09-23", savedAt: 1000 }]] });
  const cache = createSessionDateCache(store, () => 1000);
  assert.deepEqual(await cache.get("CacheVideo1"), { date: "2026-09-23", kind: "date" });
});
