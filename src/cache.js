"use strict";

// Session storage is memory-only and survives MV3 background suspension.
function createSessionDateCache(storage, now = Date.now, limit = 500) {
  const key = "exactUploadDates";
  const ttl = 6 * 60 * 60 * 1000;
  let entries;
  let queue = Promise.resolve();
  function valid(id, entry) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{6,15}$/.test(id) || !entry ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ||
        ![undefined, "date", "upload", "published"].includes(entry.kind)) return false;
    const parsed = new Date(`${entry.date}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === entry.date &&
      Number.isFinite(entry.savedAt) && entry.savedAt <= now() && now() - entry.savedAt < ttl;
  }
  function run(task) {
    const result = queue.then(async () => {
      if (!entries) {
        const saved = await storage.get(key);
        entries = new Map(Array.isArray(saved[key]) ? saved[key].filter(
          row => Array.isArray(row) && valid(row[0], row[1]),
        ) : []);
      }
      for (const [id, entry] of entries) if (!valid(id, entry)) entries.delete(id);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      return task();
    });
    queue = result.catch(() => {});
    return result;
  }
  return {
    get: id => run(() => {
      const entry = entries.get(id);
      return entry ? { date: entry.date, kind: entry.kind ?? "date" } : null;
    }),
    set: (id, metadata) => run(async () => {
      const entry = { date: metadata?.date, kind: metadata?.kind, savedAt: now() };
      if (!valid(id, entry)) return false;
      entries.delete(id);
      entries.set(id, entry);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      await storage.set({ [key]: [...entries] });
      return true;
    }),
  };
}

function createCacheListener(cache) {
  return (message, sender) => {
    if (!["youtube-exact-upload-date:cache-get", "youtube-exact-upload-date:cache-set"].includes(message?.type)) return undefined;
    // Only normal YouTube content scripts may use the cross-tab cache.
    if (!sender?.tab || sender.tab.incognito ||
        !sender.url?.startsWith("https://www.youtube.com/")) return Promise.resolve(null);
    const result = message.type.endsWith("cache-get")
      ? cache.get(message.videoId) : cache.set(message.videoId, message.metadata);
    return result.catch(() => null); // Cache availability must never block dates.
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createSessionDateCache, createCacheListener };
}
if (typeof browser !== "undefined") {
  browser.runtime.onMessage.addListener(createCacheListener(
    createSessionDateCache(browser.storage.session),
  ));
}
