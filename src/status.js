"use strict";

async function readStatus(api) {
  const report = { version: api.runtime.getManifest().version };
  report.siteAccess = await api.permissions.contains({
    origins: ["https://www.youtube.com/*"],
  });
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!report.siteAccess) {
    return { summary: "YouTube access is off. Enable it in the add-on's Permissions and data settings.", report };
  }
  try {
    if (!tab?.id) throw new Error("No active tab");
    report.content = await api.tabs.sendMessage(tab.id, {
      type: "youtube-exact-upload-date:status",
    });
    if (!report.content) throw new Error("No response");
    report.contentScript = "connected";
  } catch {
    report.contentScript = "no response";
    return {
      summary: "No response from the date script. Keep a YouTube tab active; private-window access is a separate setting.",
      report,
    };
  }
  return { summary: "Connected to the date script. Copy the report below for troubleshooting.", report };
}

async function retryFailedDates(api) {
  const allowed = await api.permissions.contains({ origins: ["https://www.youtube.com/*"] });
  if (!allowed) throw new Error("YouTube access is off");
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active YouTube tab");
  const result = await api.tabs.sendMessage(tab.id, { type: "youtube-exact-upload-date:retry" });
  if (!Number.isSafeInteger(result?.retried)) throw new Error("No response from the date script");
  return result.retried;
}

if (typeof module !== "undefined" && module.exports) module.exports = { readStatus, retryFailedDates };

if (typeof document !== "undefined" && document.querySelector("#refresh")) {
  const refresh = document.querySelector("#refresh");
  const retry = document.querySelector("#retry");
  async function update() {
    refresh.disabled = true;
    retry.disabled = true;
    try {
      const result = await readStatus(browser);
      document.querySelector("#summary").textContent = result.summary;
      document.querySelector("#report").value = JSON.stringify(result.report, null, 2);
      retry.disabled = result.report.contentScript !== "connected" ||
        !result.report.content?.failedLookups;
    } catch {
      document.querySelector("#summary").textContent = "Unable to read extension status.";
      document.querySelector("#report").value = '{"statusError":"Extension API unavailable"}';
    } finally {
      refresh.disabled = false;
    }
  }
  refresh.addEventListener("click", update);
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    try {
      const count = await retryFailedDates(browser);
      await update();
      document.querySelector("#summary").textContent = `Retrying dates for ${count} failed video${count === 1 ? "" : "s"}.`;
    } catch {
      document.querySelector("#summary").textContent = "Could not retry dates on this tab. Keep a YouTube tab active and try again.";
    }
  });
  update();
}
