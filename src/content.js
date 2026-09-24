(function exactYouTubeUploadDate() {
  "use strict";

  const MONTHS = [
    "Jan.",
    "Feb.",
    "March",
    "April",
    "May",
    "June",
    "July",
    "Aug.",
    "Sept.",
    "Oct.",
    "Nov.",
    "Dec.",
  ];

  const RELATIVE_TIME_LONG =
    /^(?:(?:premiered|streamed)\s+)?(?:\d+(?:[.,]\d+)?|a|an|one)\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago$/i;
  const RELATIVE_TIME_SHORT =
    /^\d+(?:[.,]\d+)?\s*(?:s|m|h|d|w|mo|y)\s+ago$/i;
  const RELATIVE_TIME_ABBREVIATED =
    /^(?:(?:premiered|streamed)\s+)?(?:\d+(?:[.,]\d+)?|a|an|one)\s*(?:secs?|mins?|hrs?|wks?|mos?|yrs?)\s+ago$/i;

  const METADATA_ITEM_SELECTOR = [
    "#metadata-line .inline-metadata-item",
    "ytd-video-meta-block .inline-metadata-item",
    "ytd-playlist-video-renderer #video-info span",
    "yt-content-metadata-view-model .yt-content-metadata-view-model-wiz__metadata-text",
    "yt-content-metadata-view-model span",
  ].join(",");

  const VIDEO_CONTAINER_SELECTOR = [
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-rich-item-renderer",
    "ytd-rich-grid-media",
    "ytd-compact-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-playlist-panel-video-renderer",
    "ytd-radio-renderer",
    "yt-lockup-view-model",
  ].join(",");

  const VIDEO_LINK_SELECTOR = [
    "a#video-title[href]",
    "a[href*='/watch?v=']",
    "a[href^='/shorts/']",
    "a[href^='/live/']",
  ].join(",");

  const MAX_CONCURRENT_REQUESTS = 3;
  const MAX_CACHE_ENTRIES = 500;

  const dateCache = new Map();
  const requestQueue = [];
  let activeRequests = 0;
  let scanTimer = null;
  const diagnostics = {
    scans: 0, requests: 0, datesFound: 0, redirects: 0,
    httpErrors: 0, missingDates: 0, networkErrors: 0, parseErrors: 0,
    lastHttpStatus: null, lastError: null, scanErrors: 0,
  };

  function getDiagnostics(documentRoot = document) {
    const timestamps = [...findListingTimestampCandidates(documentRoot)].filter(
      element => isRelativeTime(element.textContent) ||
        isRelativeTime(element.getAttribute("aria-label")),
    );
    return {
      version: globalThis.browser?.runtime?.getManifest().version ?? "test",
      ...diagnostics,
      relativeTimestamps: timestamps.length,
      linkedTimestamps: timestamps.filter(findVideoIdForMetadata).length,
      replaced: documentRoot.querySelectorAll("[data-youtube-exact-upload-date]").length,
      activeRequests,
      queuedRequests: requestQueue.length,
    };
  }

  function safeErrorName(error) {
    // Never expose error messages, which may contain URLs or account data.
    return ["TypeError", "SyntaxError", "SecurityError", "AbortError", "TimeoutError"]
      .includes(error?.name) ? error.name : "Error";
  }

  function normalizeCalendarDate(value) {
    if (typeof value !== "string") {
      return null;
    }

    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) {
      return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const candidate = new Date(Date.UTC(year, month - 1, day));

    if (
      candidate.getUTCFullYear() !== year ||
      candidate.getUTCMonth() !== month - 1 ||
      candidate.getUTCDate() !== day
    ) {
      return null;
    }

    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  function formatExactDate(value) {
    const normalized = normalizeCalendarDate(value);
    if (!normalized) {
      return null;
    }

    const [year, month, day] = normalized.split("-").map(Number);
    return `${MONTHS[month - 1]} ${day} ${year}`;
  }

  function isRelativeTime(value) {
    if (typeof value !== "string") {
      return false;
    }

    const normalized = value.trim().replace(/\s+/g, " ");
    return (
      RELATIVE_TIME_LONG.test(normalized) ||
      RELATIVE_TIME_SHORT.test(normalized) ||
      RELATIVE_TIME_ABBREVIATED.test(normalized)
    );
  }

  function extractVideoId(href, baseUrl = "https://www.youtube.com/") {
    if (typeof href !== "string" || href.length === 0) {
      return null;
    }

    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      return null;
    }

    if (!/(^|\.)youtube\.com$/i.test(url.hostname)) {
      return null;
    }

    let videoId = null;
    if (url.pathname === "/watch") {
      videoId = url.searchParams.get("v");
    } else {
      const pathMatch = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/);
      videoId = pathMatch?.[1] ?? null;
    }

    return videoId && /^[A-Za-z0-9_-]{6,15}$/.test(videoId)
      ? videoId
      : null;
  }

  function extractPublishedDate(html) {
    if (typeof html !== "string" || html.length === 0) {
      return null;
    }

    if (typeof DOMParser !== "undefined") {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const content = parsed
        .querySelector(
          'meta[itemprop="uploadDate"], meta[itemprop="datePublished"]',
        )
        ?.getAttribute("content");
      const normalized = normalizeCalendarDate(content);
      if (normalized) {
        return normalized;
      }
    }

    const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
    for (const tag of metaTags) {
      if (!/itemprop=["'](?:uploadDate|datePublished)["']/i.test(tag)) {
        continue;
      }

      const content = tag.match(/content=["']([^"']+)["']/i)?.[1];
      const normalized = normalizeCalendarDate(content);
      if (normalized) {
        return normalized;
      }
    }

    const jsonDate = html.match(
      /["'](?:uploadDate|publishDate)["']\s*:\s*["'](\d{4}-\d{2}-\d{2})/i,
    )?.[1];
    return normalizeCalendarDate(jsonDate);
  }

  function readDocumentPublishedDate(documentRoot) {
    const content = documentRoot
      .querySelector(
        'meta[itemprop="uploadDate"], meta[itemprop="datePublished"]',
      )
      ?.getAttribute("content");
    return normalizeCalendarDate(content);
  }

  function scheduleRequest(task) {
    return new Promise((resolve) => {
      requestQueue.push({ resolve, task });
      drainRequestQueue();
    });
  }

  function drainRequestQueue() {
    while (
      activeRequests < MAX_CONCURRENT_REQUESTS &&
      requestQueue.length > 0
    ) {
      const { resolve, task } = requestQueue.shift();
      activeRequests += 1;

      Promise.resolve()
        .then(task)
        .then(resolve, () => resolve(null))
        .finally(() => {
          activeRequests -= 1;
          drainRequestQueue();
        });
    }
  }

  function rememberDate(videoId, promise) {
    if (dateCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = dateCache.keys().next().value;
      dateCache.delete(oldestKey);
    }
    dateCache.set(videoId, promise);
    return promise;
  }

  function getExactDateForVideo(videoId) {
    if (dateCache.has(videoId)) {
      return dateCache.get(videoId);
    }

    const lookup = scheduleRequest(async () => {
      diagnostics.requests += 1;
      let parsing = false;
      try {
        const url = new URL("/watch", globalThis.location.origin);
        url.searchParams.set("v", videoId);
        const response = await globalThis.fetch(url.href, {
          cache: "force-cache",
          // YouTube redirects cookie-less watch requests across origins in
          // Firefox, which makes fetch reject before we can read the date.
          credentials: "same-origin",
          referrerPolicy: "no-referrer",
        });
        diagnostics.lastHttpStatus = response.status ?? null;
        if (response.redirected) diagnostics.redirects += 1;
        if (!response.ok) {
          diagnostics.httpErrors += 1;
          return null;
        }

        const html = await response.text();
        parsing = true;
        const date = extractPublishedDate(html);
        if (date) diagnostics.datesFound += 1;
        else diagnostics.missingDates += 1;
        return date;
      } catch (error) {
        if (parsing) diagnostics.parseErrors += 1;
        else diagnostics.networkErrors += 1;
        diagnostics.lastError = safeErrorName(error);
        return null;
      }
    });

    return rememberDate(videoId, lookup);
  }

  function setExactDate(element, date, videoId) {
    const formatted = formatExactDate(date);
    if (!formatted || !element.isConnected) {
      return false;
    }

    element.textContent = formatted;
    element.setAttribute("aria-label", `Uploaded ${formatted}`);
    element.setAttribute("title", `Uploaded ${formatted}`);
    element.dataset.youtubeExactUploadDate = videoId;
    delete element.dataset.youtubeExactUploadDatePending;
    return true;
  }

  function findVideoIdForMetadata(element) {
    const container = element.closest(VIDEO_CONTAINER_SELECTOR);
    const link = container?.querySelector(VIDEO_LINK_SELECTOR);
    return extractVideoId(link?.getAttribute("href"), globalThis.location?.href);
  }

  function findListingTimestampCandidates(documentRoot) {
    const candidates = new Set(
      documentRoot.querySelectorAll(METADATA_ITEM_SELECTOR),
    );

    for (const card of documentRoot.querySelectorAll(
      VIDEO_CONTAINER_SELECTOR,
    )) {
      for (const element of card.querySelectorAll(
        "span, yt-formatted-string",
      )) {
        if (element.closest("h1, h2, h3")) {
          continue;
        }

        const accessibleText = element.getAttribute("aria-label");
        if (
          isRelativeTime(element.textContent) ||
          isRelativeTime(accessibleText)
        ) {
          candidates.add(element);
        }
      }
    }

    return candidates;
  }

  function updateListingItem(element) {
    if (
      !isRelativeTime(element.textContent) &&
      !isRelativeTime(element.getAttribute("aria-label"))
    ) {
      return;
    }

    const videoId = findVideoIdForMetadata(element);
    if (!videoId) {
      return;
    }

    if (element.dataset.youtubeExactUploadDatePending === videoId) {
      return;
    }

    element.dataset.youtubeExactUploadDatePending = videoId;
    getExactDateForVideo(videoId).then((date) => {
      if (!date || !element.isConnected) {
        delete element.dataset.youtubeExactUploadDatePending;
        return;
      }

      const currentVideoId = findVideoIdForMetadata(element);
      if (currentVideoId === videoId) {
        setExactDate(element, date, videoId);
      }
    });
  }

  function updateWatchPage(documentRoot) {
    const videoId = extractVideoId(globalThis.location.href);
    const date = readDocumentPublishedDate(documentRoot);
    if (!videoId || !date) {
      return;
    }

    const targets = documentRoot.querySelectorAll(
      "ytd-watch-info-text #date-text, ytd-watch-metadata #date-text, #info-strings yt-formatted-string",
    );
    for (const target of targets) {
      if (target.dataset.youtubeExactUploadDate !== videoId) {
        setExactDate(target, date, videoId);
      }
    }
  }

  function scanPage(documentRoot = document) {
    diagnostics.scans += 1;
    updateWatchPage(documentRoot);
    for (const element of findListingTimestampCandidates(documentRoot)) {
      updateListingItem(element);
    }
  }

  function scanSafely() {
    try {
      scanPage(document);
    } catch (error) {
      diagnostics.scanErrors += 1;
      diagnostics.lastError = safeErrorName(error);
    }
  }

  function scheduleScan() {
    if (scanTimer !== null) {
      return;
    }

    scanTimer = globalThis.setTimeout(() => {
      scanTimer = null;
      scanSafely();
    }, 100);
  }

  function start() {
    // Register before scanning so a startup failure can still be diagnosed.
    globalThis.browser?.runtime?.onMessage.addListener(message => {
      if (message?.type === "youtube-exact-upload-date:status") {
        try {
          return Promise.resolve(getDiagnostics(document));
        } catch (error) {
          return Promise.resolve({ ...diagnostics, statusError: safeErrorName(error) });
        }
      }
      return undefined;
    });
    scanSafely();

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    document.addEventListener("yt-navigate-finish", scheduleScan);
    document.addEventListener("yt-page-data-updated", scheduleScan);
  }

  const publicApi = {
    extractPublishedDate,
    extractVideoId,
    formatExactDate,
    getDiagnostics,
    isRelativeTime,
    normalizeCalendarDate,
    scanPage,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = publicApi;
  }

  if (
    typeof document !== "undefined" &&
    typeof MutationObserver !== "undefined" &&
    /(^|\.)youtube\.com$/i.test(globalThis.location?.hostname ?? "")
  ) {
    start();
  }
})();
