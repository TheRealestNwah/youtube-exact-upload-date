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

if (typeof module !== "undefined" && module.exports) module.exports = { readStatus };

if (typeof document !== "undefined" && document.querySelector("#refresh")) {
  const refresh = document.querySelector("#refresh");
  async function update() {
    refresh.disabled = true;
    try {
      const result = await readStatus(browser);
      document.querySelector("#summary").textContent = result.summary;
      document.querySelector("#report").value = JSON.stringify(result.report, null, 2);
    } catch {
      document.querySelector("#summary").textContent = "Unable to read extension status.";
      document.querySelector("#report").value = '{"statusError":"Extension API unavailable"}';
    } finally {
      refresh.disabled = false;
    }
  }
  refresh.addEventListener("click", update);
  update();
}
