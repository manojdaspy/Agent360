// background.js
// Handles all API calls — runs in service worker context

const DEFAULT_CONFIG = {
  baseUrl:   "https://studentassignment.lyralogics.com",
  token:     "",
  enabled:   true,
  debugMode: false,
};


// ── Storage helpers ────────────────────────────────────────────────────────

async function getConfig() {
  return new Promise(resolve => {
    chrome.storage.sync.get(DEFAULT_CONFIG, resolve);
  });
}


// ── API caller ─────────────────────────────────────────────────────────────

async function callAgentAPI(op, params) {
  const config = await getConfig();

  if (!config.enabled) {
    return { ok: false, error: "Extension is disabled." };
  }
  if (!config.token) {
    return { ok: false, error: "No API token set. Open extension popup and add your token." };
  }

  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const headers  = {
    "Authorization": `Bearer ${config.token}`,
    "Content-Type":  "application/json",
  };

  // Ops that use GET
  const GET_OPS = new Set([
    "tree", "dir", "cat", "search",
    "git_status", "git_diff", "git_log", "git_blame",
    "pytest", "flake8",
  ]);

  // Ops that use POST
  const POST_OPS = new Set([
    "write", "patch", "shell", "mkdir", "delete",
    "django_check",
  ]);

  try {
    let response;

    if (GET_OPS.has(op)) {
      // Build query string from params
      const qs = new URLSearchParams({ op, ...params }).toString();
      const url = `${baseUrl}/api/agent/cmd/?${qs}`;

      if (config.debugMode) console.log("[VibesCode] GET", url);

      response = await fetch(url, { method: "GET", headers });

    } else if (POST_OPS.has(op)) {
      const url  = `${baseUrl}/api/agent/cmd/`;
      const body = JSON.stringify({ op, ...params });

      if (config.debugMode) console.log("[VibesCode] POST", url, body);

      response = await fetch(url, { method: "POST", headers, body });

    } else {
      return { ok: false, error: `Unknown op: ${op}` };
    }

    const data = await response.json();

    if (config.debugMode) console.log("[VibesCode] Response", data);

    return data;

  } catch (err) {
    console.error("[VibesCode] API error:", err);
    return { ok: false, error: `Network error: ${err.message}` };
  }
}


// ── Message listener — receives calls from content.js ─────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "AGENT_CALL") {
    callAgentAPI(message.op, message.params)
      .then(result => sendResponse({ success: true, result }))
      .catch(err  => sendResponse({ success: false, error: err.message }));

    return true; // keeps the message channel open for async response
  }

  if (message.type === "TEST_CONNECTION") {
    getConfig().then(async config => {
      try {
        const res = await fetch(
          `${config.baseUrl.replace(/\/$/, "")}/api/agent/cmd/?op=tree&path=.`,
          { headers: { "Authorization": `Bearer ${config.token}` } }
        );
        const data = await res.json();
        sendResponse({ ok: data.ok, status: res.status });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }

});