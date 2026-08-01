(() => {
  "use strict";

  const textEl = document.getElementById("rulesText");
  const statusEl = document.getElementById("rulesStatus");
  const errorsEl = document.getElementById("rulesErrors");
  const saveBtn = document.getElementById("saveRules");
  const reloadBtn = document.getElementById("reloadRules");

  async function load() {
    const data = await chrome.runtime.sendMessage({ type: "getUserRules" });
    textEl.value = data?.text || "";
    statusEl.textContent = data
      ? `${(data.blocks || []).length} blocks · ${Object.keys(data.cosmetics || {}).length} cosmetic hosts`
      : "";
    errorsEl.hidden = true;
  }

  async function save() {
    saveBtn.disabled = true;
    statusEl.textContent = "Saving…";
    try {
      const res = await chrome.runtime.sendMessage({
        type: "setUserRules",
        text: textEl.value,
      });
      if (!res?.ok) {
        statusEl.textContent = res?.error || "Save failed";
        return;
      }
      statusEl.textContent = `Saved · ${res.blocks.length} blocks · ${Object.keys(res.cosmetics).length} cosmetic hosts`;
      if (res.errors?.length) {
        errorsEl.hidden = false;
        errorsEl.textContent = res.errors.slice(0, 12).join("\n");
      } else {
        errorsEl.hidden = true;
      }
    } finally {
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener("click", () => save());
  reloadBtn.addEventListener("click", () => load());
  load();
})();
