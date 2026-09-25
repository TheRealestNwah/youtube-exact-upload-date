"use strict";

const dateFormatSelect = document.querySelector("#date-format");
const dateFormatPreview = document.querySelector("#preview");
const formats = new Set(["classic", "iso", "locale"]);

function updatePreview() {
  const example = dateFormatSelect.value === "locale"
    ? new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
    }).format(new Date(Date.UTC(2026, 8, 22)))
    : dateFormatSelect.selectedOptions[0].textContent;
  dateFormatPreview.textContent = `Example: ${example}`;
}

browser.storage.local.get("dateFormat").then(result => {
  dateFormatSelect.value = formats.has(result.dateFormat) ? result.dateFormat : "classic";
  updatePreview();
});
dateFormatSelect.addEventListener("change", async () => {
  await browser.storage.local.set({ dateFormat: dateFormatSelect.value });
  updatePreview();
});
