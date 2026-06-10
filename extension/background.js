// background.js — VibesCode v9
// ════════════════════════════════════════════════════════════════════════════
// The MCP transport (SSE + POST) is now handled entirely in content.js
// using the browser's native EventSource + fetch APIs.
//
// background.js is kept for:
//   • Storing / retrieving config (base URL, API token, debug flag)
//   • Handling the popup "Test Connection" button
//   • Future use: offscreen MCP client for non-tab contexts
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  baseUrl:   "https://studentassignment.lyralogics.com",
  token:     "",
  enabled:   true,
  debugMode: false,
};

async function getConfig() {
  return new Promise(resolve => chrome.storage.sync.get(DEFAULT_CONFIG, resolve));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Config read (used by content.js to get the correct base URL)
  if (message.type === "GET_CONFIG") {
    getConfig().then(cfg => sendResponse({ ok: true, config: cfg }));
    return true;
  }

  // Test connection — calls MCP health endpoint
  if (message.type === "TEST_CONNECTION") {
    getConfig().then(async cfg => {
      try {
        const res  = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/mcp/health`);
        const data = await res.json();
        sendResponse({ ok: data.ok, status: res.status, data });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }

});