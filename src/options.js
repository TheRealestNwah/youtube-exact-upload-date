"use strict";

const dateFormatSelect = document.querySelector("#date-format");
const dateFormatPreview = document.querySelector("#preview");
const displayModeSelect = document.querySelector("#display-mode");
const formats = new Set(["classic", "iso", "locale"]);

function updatePreview() {
  const example = dateFormatSelect.value === "locale"
    ? new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
    }).format(new Date(Date.UTC(2026, 8, 22)))
    : dateFormatSelect.selectedOptions[0].textContent;
  dateFormatPreview.textContent = `Example: ${example}`;
}

browser.storage.local.get(["dateFormat", "displayMode"]).then(result => {
  dateFormatSelect.value = formats.has(result.dateFormat) ? result.dateFormat : "classic";
  displayModeSelect.value = result.displayMode === "both" ? "both" : "exact";
  updatePreview();
});
displayModeSelect.addEventListener("change", () => {
  browser.storage.local.set({ displayMode: displayModeSelect.value });
});
dateFormatSelect.addEventListener("change", async () => {
  await browser.storage.local.set({ dateFormat: dateFormatSelect.value });
  updatePreview();
});
