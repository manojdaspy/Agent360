// popup.js

const $ = id => document.getElementById(id);

// ── Load saved settings ────────────────────────────────────────────────────

chrome.storage.sync.get({
  baseUrl:   "https://studentassignment.lyralogics.com",
  token:     "",
  enabled:   true,
  debugMode: false,
}, (cfg) => {
  $("baseUrl").value = cfg.baseUrl;
  $("token").value   = cfg.token;
  setToggle("enabledToggle", cfg.enabled);
  setToggle("debugToggle",   cfg.debugMode);
});


// ── Toggle helper ──────────────────────────────────────────────────────────

function setToggle(id, value) {
  const el = $(id);
  el.classList.toggle("on", value);
  el.dataset.value = value ? "1" : "0";
}

function getToggle(id) {
  return $(id).dataset.value === "1";
}

$("enabledToggle").onclick = () => {
  const current = getToggle("enabledToggle");
  setToggle("enabledToggle", !current);
};

$("debugToggle").onclick = () => {
  const current = getToggle("debugToggle");
  setToggle("debugToggle", !current);
};


// ── Save ───────────────────────────────────────────────────────────────────

$("saveBtn").onclick = () => {
  const cfg = {
    baseUrl:   $("baseUrl").value.trim(),
    token:     $("token").value.trim(),
    enabled:   getToggle("enabledToggle"),
    debugMode: getToggle("debugToggle"),
  };

  chrome.storage.sync.set(cfg, () => {
    showStatus("✅ Settings saved.", "ok");
  });
};


// ── Test connection ────────────────────────────────────────────────────────

$("testBtn").onclick = () => {
  showStatus("Testing...", "");
  $("testBtn").disabled = true;

  chrome.runtime.sendMessage({ type: "TEST_CONNECTION" }, (response) => {
    $("testBtn").disabled = false;
    if (response?.ok) {
      showStatus("✅ Connected! API is reachable.", "ok");
    } else {
      showStatus(`❌ Failed: ${response?.error || "No response"}`, "error");
    }
  });
};


// ── Status helper ──────────────────────────────────────────────────────────

function showStatus(msg, type) {
  const el = $("statusMsg");
  el.textContent = msg;
  el.className   = `status ${type}`;
}