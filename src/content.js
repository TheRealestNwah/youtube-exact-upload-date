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

  // Fill the visible Home row promptly without firing every card at once.
  const MAX_CONCURRENT_REQUESTS = 8;
  const MAX_CACHE_ENTRIES = 500;

  const dateCache = new Map();
  const DATE_FORMAT_KEY = "dateFormat";
  const DISPLAY_MODE_KEY = "displayMode";
  const DATE_FORMATS = new Set(["classic", "iso", "locale"]);
  let dateFormat = "classic";
  let displayMode = "exact";
  const requestQueue = [];
  let activeRequests = 0;
  let scanTimer = null;
  const loadingStates = new WeakMap();
  const diagnostics = {
    scans: 0, requests: 0, datesFound: 0, redirects: 0,
    httpErrors: 0, missingDates: 0, networkErrors: 0, parseErrors: 0,
    lastHttpStatus: null, lastError: null, scanErrors: 0, sessionCacheHits: 0,
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

  function formatExactDate(value, style = dateFormat) {
    const normalized = normalizeCalendarDate(value);
    if (!normalized) {
      return null;
    }

    if (style === "iso") return normalized;
    const [year, month, day] = normalized.split("-").map(Number);
    if (style === "locale") {
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
      }).format(new Date(Date.UTC(year, month - 1, day)));
    }
    return `${MONTHS[month - 1]} ${day} ${year}`;
  }

  function rerenderDates() {
    for (const element of document.querySelectorAll("[data-youtube-exact-upload-calendar-date]")) {
      setExactDate(element, element.dataset.youtubeExactUploadCalendarDate,
        element.dataset.youtubeExactUploadDate);
    }
  }

  function applyDateFormat(style) {
    dateFormat = DATE_FORMATS.has(style) ? style : "classic";
    rerenderDates();
  }

  function applyDisplayMode(mode) {
    displayMode = mode === "both" ? "both" : "exact";
    rerenderDates();
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

    // This tag is normally in the first few KB of a watch response. A small
    // text search avoids constructing a full DOM for every uncached video.
    const firstTag = html.match(
      /<meta\b[^>]*\bitemprop\s*=\s*(["'])(?:uploadDate|datePublished)\1[^>]*>/i,
    )?.[0];
    const firstDate = normalizeCalendarDate(
      firstTag?.match(/\bcontent\s*=\s*(["'])([^"']+)\1/i)?.[2],
    );
    if (firstDate) return firstDate;

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
    const serializedDate = normalizeCalendarDate(jsonDate);
    if (serializedDate) return serializedDate;

    // Handle unusual but valid markup without slowing down normal responses.
    if (typeof DOMParser !== "undefined") {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const content = parsed.querySelector(
        'meta[itemprop="uploadDate"], meta[itemprop="datePublished"]',
      )?.getAttribute("content");
      return normalizeCalendarDate(content);
    }
    return null;
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

    const lookup = (async () => {
      const cached = await sessionCache("get", videoId);
      const cachedDate = normalizeCalendarDate(cached);
      if (cachedDate) {
        diagnostics.sessionCacheHits += 1;
        return cachedDate;
      }
      return scheduleRequest(async () => {
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
          if (date) {
            diagnostics.datesFound += 1;
            void sessionCache("set", videoId, date);
          } else diagnostics.missingDates += 1;
          return date;
        } catch (error) {
          if (parsing) diagnostics.parseErrors += 1;
          else diagnostics.networkErrors += 1;
          diagnostics.lastError = safeErrorName(error);
          return null;
        }
      });
    })();

    return rememberDate(videoId, lookup);
  }

  async function sessionCache(operation, videoId, date) {
    const api = globalThis.browser;
    if (!api?.runtime?.sendMessage || api.extension?.inIncognitoContext) return null;
    let timer;
    try {
      // An unavailable background script must not hold up normal lookups.
      return await Promise.race([
        api.runtime.sendMessage({ type: `youtube-exact-upload-date:cache-${operation}`, videoId, date }),
        new Promise(resolve => { timer = globalThis.setTimeout(() => resolve(null), 150); }),
      ]);
    } catch { return null; }
    finally { globalThis.clearTimeout(timer); }
  }

  function beginLoading(element, videoId) {
    const previous = loadingStates.get(element);
    if (previous) finishLoading(element, previous);
    const state = { videoId, busy: element.getAttribute("aria-busy") };
    loadingStates.set(element, state);
    element.dataset.youtubeExactUploadDatePending = videoId;
    element.dataset.youtubeExactUploadDateLoading = videoId;
    element.setAttribute("aria-busy", "true");
    state.timer = globalThis.setTimeout(() => revealOriginal(element, state), 1800);
    return state;
  }

  function revealOriginal(element, state) {
    if (loadingStates.get(element) !== state) return;
    delete element.dataset.youtubeExactUploadDateLoading;
    if (state.busy === null) element.removeAttribute("aria-busy");
    else element.setAttribute("aria-busy", state.busy);
  }

  function finishLoading(element, state) {
    if (loadingStates.get(element) !== state) return;
    globalThis.clearTimeout(state.timer);
    revealOriginal(element, state);
    delete element.dataset.youtubeExactUploadDatePending;
    loadingStates.delete(element);
  }

  function setExactDate(element, date, videoId) {
    const formatted = formatExactDate(date);
    if (!formatted || !element.isConnected) {
      return false;
    }

    if (!element.dataset.youtubeExactUploadRelativeTime) {
      const relative = [element.textContent, element.getAttribute("aria-label")]
        .find(isRelativeTime);
      if (relative) element.dataset.youtubeExactUploadRelativeTime = relative.trim();
    }
    const relative = element.dataset.youtubeExactUploadRelativeTime;
    element.textContent = displayMode === "both" && relative
      ? `${formatted} · ${relative}` : formatted;
    const accessible = `Uploaded ${formatted}${displayMode === "both" && relative ? `; ${relative}` : ""}`;
    element.setAttribute("aria-label", accessible);
    element.setAttribute("title", accessible);
    element.dataset.youtubeExactUploadDate = videoId;
    element.dataset.youtubeExactUploadCalendarDate = date;
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

    const state = beginLoading(element, videoId);
    getExactDateForVideo(videoId).then((date) => {
      if (loadingStates.get(element) !== state) return;
      finishLoading(element, state);
      if (!date || !element.isConnected) {
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
    }, 16);
  }

  function start() {
    const storage = globalThis.browser?.storage;
    if (storage?.local) {
      storage.local.get([DATE_FORMAT_KEY, DISPLAY_MODE_KEY]).then(
        result => {
          applyDateFormat(result?.[DATE_FORMAT_KEY]);
          applyDisplayMode(result?.[DISPLAY_MODE_KEY]);
        }, () => {},
      );
      storage.onChanged?.addListener((changes, area) => {
        if (area === "local" && changes[DATE_FORMAT_KEY]) {
          applyDateFormat(changes[DATE_FORMAT_KEY].newValue);
        }
        if (area === "local" && changes[DISPLAY_MODE_KEY]) {
          applyDisplayMode(changes[DISPLAY_MODE_KEY].newValue);
        }
      });
    }
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
    observer.observe(document, {
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
