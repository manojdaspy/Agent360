// content.js — VibesCode Agent v7
// Major fixes:
//   - Built-in DOM inspector so YOU can find the right selectors live
//   - Gemini 2025 selectors updated
//   - Debug mode shows every selector it tries
//   - Console shows Q&A even when no tool calls made
//   - Colour-coded live message feed
(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════
  // 0. CONSTANTS
  // ═══════════════════════════════════════════════════════════════════
  const SCAN_INTERVAL   = 700;
  const TOOL_TIMEOUT_MS = 30_000;
  const KEYWORD_RE      = /_*AGENT_CALL_*/g;

  // ── Gemini 2025 selectors (most specific → least) ────────────────
  // These cover current Gemini DOM structure as of mid-2025
  const USER_MSG_SELECTORS = [
    // Gemini
    "user-query span.user-query-bubble-with-background", // Most specific wrapper
    "user-query .query-text",                            // Text wrapper
    "user-query p.query-text-line",                       // The actual text paragraph
    "user-query",                                         // Custom element fallback
    // Claude
    '[data-testid="user-message"]',
    // ChatGPT
    '[data-turn="user"] [data-message-author-role="user"] .user-message-bubble-color div', // Deepest text wrapper
    '[data-message-author-role="user"] .whitespace-pre-wrap',                            // Target text directly
    '[data-testid^="conversation-turn-"] [data-turn="user"]',                             // Turn wrapper
    '[data-message-author-role="user"]',                                                 // Role fallback

    // Generic
    ".human-turn",
    ".user-message",
    "[class*='user-turn']",
    "[class*='human-message']",
  ];

  const AI_MSG_SELECTORS = [
    // Gemini
    "model-response .markdown-main-panel",                // Main response panel body
    "model-response message-content div.markdown",        // Structural text wrapper
    "model-response .response-content",                   // Section wrapper
    "model-response .model-response-text",                // Component wrapper
    "model-response",                                     // Custom element fallback
    // Claude
    '[data-testid="assistant-message"]',
    '[data-testid="assistant-message"] .whitespace-pre-wrap',
    // ChatGPT
   '[data-turn="assistant"] [data-message-author-role="assistant"] .markdown',         // Main markdown engine wrapper
   '[data-message-author-role="assistant"] .markdown-new-styling',                     // Class seen in the DOM
   '[data-testid^="conversation-turn-"] [data-turn="assistant"]',                      // Turn wrapper
   '[data-message-author-role="assistant"]',                                            // Role fallback

    // Generic
    ".assistant-turn",
    ".bot-message",
    "[class*='assistant-message']",
    "[class*='model-turn']",
  ];

  const INPUT_SELECTORS = [
    // Gemini
    'div[contenteditable="true"][aria-label]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"]',
    // ChatGPT / others
    '#prompt-textarea[contenteditable="true"]',                                         // Specific ID wrapper
    '.ProseMirror[role="textbox"]',                                                     // ProseMirror rich text context
    'textarea.wcDTda_fallbackTextarea',                                                 // Fallback textarea visible in source
  ];

  const SEND_BTN_SELECTORS = [
    // Gemini
    'button[aria-label="Send message"]:not([disabled])',
    'button.send-button:not([disabled])',
    'button[data-testid="send-button"]:not([disabled])',
    'button[aria-label="Send"]:not([disabled])',
    //Chatgpt
    'form[data-type="unified-composer"] button[type="submit"]',                          // Standard form submission mapping
    'form button:has(svg)',                                                             // Target icon buttons within the composer form

    // Generic
    'button[type="submit"]:not([disabled])',
  ];

  // ═══════════════════════════════════════════════════════════════════
  // 1. JSON EXTRACTOR
  // ═══════════════════════════════════════════════════════════════════
  function extractJSON(text, fromIndex) {
    let i = fromIndex;
    while (i < text.length && text[i] !== "{") i++;
    if (i >= text.length) return null;
    const start = i;
    let depth = 0;
    for (; i < text.length; i++) {
      if      (text[i] === "{") depth++;
      else if (text[i] === "}") { if (--depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  }

  function findAllCalls(text) {
    const results = [];
    KEYWORD_RE.lastIndex = 0;
    let m;
    while ((m = KEYWORD_RE.exec(text)) !== null) {
      const json = extractJSON(text, m.index + m[0].length);
      if (json) results.push(json);
    }
    return results;
  }

  function normaliseJSON(raw) {
    return raw.trim()
      .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\s+/g, " ");
  }

  function safeParseJSON(raw) {
    const s = normaliseJSON(raw);
    try { return JSON.parse(s); }            catch (_) {}
    try { return JSON.parse("{" + s + "}"); } catch (_) {}
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 2. DOM HELPERS
  // ═══════════════════════════════════════════════════════════════════
  const inputElements = new WeakSet();

  function getInputBox() {
    for (const sel of INPUT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function getInputBoxText() {
    const el = getInputBox();
    return el ? (el.innerText || el.value || "").trim() : "";
  }

  // Collects ALL visible message text, user + AI combined
  function getAllMessagesText() {
    let text = "";
    const allSels = [...USER_MSG_SELECTORS, ...AI_MSG_SELECTORS];
    const seen    = new Set();

    for (const sel of allSels) {
      document.querySelectorAll(sel).forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        const inp = getInputBox();
        if (inp && (el === inp || el.contains(inp))) return;
        text += (el.innerText || "") + "\n";
      });
    }
    return text;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. LIVE MESSAGE FEED  ← NEW
  //    Watches chat and logs every new Q&A pair to the console
  // ═══════════════════════════════════════════════════════════════════
  let lastSeenMessages = "";

  function scanMessages() {
    // Try to find user + AI messages separately and log them
    let foundAny = false;

    for (const sel of USER_MSG_SELECTORS) {
      const els = document.querySelectorAll(sel);
      if (els.length) {
        foundAny = true;
        break;
      }
    }

    const allText = getAllMessagesText().trim();
    if (!allText || allText === lastSeenMessages) return;
    lastSeenMessages = allText;

    // Log user messages
    for (const sel of USER_MSG_SELECTORS) {
      document.querySelectorAll(sel).forEach(el => {
        const t = el.innerText?.trim();
        if (t && t.length > 2) {
          logToTerminal("user", "👤 You", { message: t });
        }
      });
    }

    // Log AI messages
    for (const sel of AI_MSG_SELECTORS) {
      document.querySelectorAll(sel).forEach(el => {
        const t = el.innerText?.trim();
        if (t && t.length > 2 && !t.includes("AGENT_CALL")) {
          logToTerminal("ai", "🤖 AI", { message: t.slice(0, 300) + (t.length > 300 ? "…" : "") });
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 4. DOM INSPECTOR  ← NEW
  //    Click "🔍 Inspect" in console to dump what selectors match
  //    Helps debug which selectors work on current page
  // ═══════════════════════════════════════════════════════════════════
  function runDOMInspector() {
    logToTerminal("info", "🔍 DOM Inspector Running…", {});

    const report = {};

    // Check input box
    for (const sel of INPUT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        report["✅ Input box"] = sel;
        break;
      }
    }
    if (!report["✅ Input box"]) report["❌ Input box"] = "NOT FOUND";

    // Check send button
    for (const sel of SEND_BTN_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        report["✅ Send button"] = sel;
        break;
      }
    }
    if (!report["✅ Send button"]) {
      // try disabled version
      const anyBtn = document.querySelector('button[aria-label="Send message"]');
      report["❌ Send button"] = anyBtn ? "Found but DISABLED" : "NOT FOUND";
    }

    // Check user messages
    let userFound = false;
    for (const sel of USER_MSG_SELECTORS) {
      const els = document.querySelectorAll(sel);
      if (els.length) {
        report[`✅ User msg (${els.length})`] = sel;
        userFound = true;
        break;
      }
    }
    if (!userFound) report["❌ User messages"] = "NOT FOUND";

    // Check AI messages
    let aiFound = false;
    for (const sel of AI_MSG_SELECTORS) {
      const els = document.querySelectorAll(sel);
      if (els.length) {
        report[`✅ AI msg (${els.length})`] = sel;
        aiFound = true;
        break;
      }
    }
    if (!aiFound) report["❌ AI messages"] = "NOT FOUND";

    // Dump all custom elements (web components like Gemini uses)
    const customEls = new Set();
    document.querySelectorAll("*").forEach(el => {
      if (el.tagName.includes("-")) customEls.add(el.tagName.toLowerCase());
    });
    report["🧩 Custom elements"] = [...customEls].join(", ") || "none";

    // Dump data-* attributes on likely containers
    const dataAttrs = new Set();
    document.querySelectorAll("[data-turn-role],[data-message-author-role],[data-testid]")
      .forEach(el => {
        const role = el.dataset.turnRole || el.dataset.messageAuthorRole || el.dataset.testid;
        if (role) dataAttrs.add(`${el.tagName.toLowerCase()}[${role}]`);
      });
    report["🏷️ Data attributes found"] = [...dataAttrs].slice(0, 10).join(", ") || "none";

    logToTerminal("info", "🔍 DOM Report", report);
    logToTerminal("info", "💡 Tip", {
      hint: "If selectors show NOT FOUND, right-click a message in chat → Inspect → copy the selector and report it."
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 5. OLD-CHAT SNAPSHOT
  // ═══════════════════════════════════════════════════════════════════
  const OLD_CHAT_SNAPSHOT = new Set();
  let snapshotLocked   = false;
  let lastSnapshotHash = "";
  let snapshotAttempts = 0;

  function tryBuildSnapshot() {
    if (snapshotLocked) return;
    const calls = findAllCalls(getAllMessagesText());
    const hash  = calls.map(normaliseJSON).join("|");
    if (hash !== "" && hash === lastSnapshotHash) {
      calls.forEach(c => OLD_CHAT_SNAPSHOT.add(normaliseJSON(c)));
      snapshotLocked = true;
      logToTerminal("info", "📸 Snapshot locked", { oldCalls: OLD_CHAT_SNAPSHOT.size });
    } else {
      lastSnapshotHash = hash;
    }
  }

  const snapTimer = setInterval(() => {
    tryBuildSnapshot();
    if (snapshotLocked || ++snapshotAttempts > 20) {
      clearInterval(snapTimer);
      if (!snapshotLocked) {
        snapshotLocked = true;
        logToTerminal("info", "📸 Fresh page — no old calls", {});
      }
    }
  }, 400);

  // ═══════════════════════════════════════════════════════════════════
  // 6. TOOL CALL HANDLER
  // ═══════════════════════════════════════════════════════════════════
  const processedCalls = new Set();
  let   callInFlight   = false;

  async function handleAgentCall(rawJSON) {
    if (callInFlight) return;
    callInFlight = true;

    const parsed = safeParseJSON(rawJSON);
    if (!parsed) {
      logToTerminal("error", "⚠️ Parse error", { raw: rawJSON });
      callInFlight = false;
      return;
    }

    const { op, ...params } = parsed;
    logToTerminal("request", `📡 CALLING: ${op.toUpperCase()}`, { op, params });

    const waitId = showWaitingBanner(op);
    let result;
    try {
      result = await Promise.race([
        sendToBackground(op, params),
        rejectAfter(TOOL_TIMEOUT_MS),
      ]);
    } catch (err) {
      result = { ok: false, error: err.message };
    }

    removeWaitingBanner(waitId);

    if (result.ok) {
      logToTerminal("success", `✅ RESULT: ${op.toUpperCase()}`, result);
    } else {
      logToTerminal("error", `❌ FAILED: ${op.toUpperCase()}`, result);
    }

    await injectToolResult(op, result);
    callInFlight = false;
  }

  function sendToBackground(op, params) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "AGENT_CALL", op, params }, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res?.result || { ok: false, error: "No response from background" });
      });
    });
  }

  function rejectAfter(ms) {
    return new Promise((_, r) =>
      setTimeout(() => r(new Error(`Timeout after ${ms / 1000}s`)), ms));
  }

  // ═══════════════════════════════════════════════════════════════════
  // 7. INJECT RESULT → INPUT BOX
  // ═══════════════════════════════════════════════════════════════════
  function injectToolResult(op, result) {
    return new Promise((resolve) => {
      const text =
        `__TOOL_RESULT__\nop: ${op}\n` +
        JSON.stringify(result, null, 2) +
        `\n__END_RESULT__\n\nContinue based on the result above.`;

      const input = getInputBox();
      if (!input) {
        logToTerminal("error", "⚠️ No input box found", {
          tried: INPUT_SELECTORS,
          hint: "Click 🔍 Inspect to debug selectors"
        });
        return resolve();
      }

      input.focus();
      let injected = false;

      // Strategy A: React textarea
      if (input.tagName === "TEXTAREA") {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value"
        )?.set;
        if (nativeSetter) { nativeSetter.call(input, text); injected = true; }
        else              { input.value = text;              injected = true; }
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }

      // Strategy B: contenteditable (Gemini, Claude)
      if (!injected || input.isContentEditable) {
        input.focus();
        // Select all existing content
        const sel   = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.removeAllRanges();
        sel.addRange(range);

        injected = document.execCommand("insertText", false, text);
        if (!injected) {
          // Strategy C: direct innerText
          input.innerText = text;
          input.dispatchEvent(new InputEvent("input", {
            bubbles: true, data: text, inputType: "insertText",
          }));
          injected = true;
        }
      }

      logToTerminal("info", injected ? "✏️ Text injected" : "⚠️ Injection uncertain", {
        length: text.length,
        inputType: input.tagName,
      });

      waitForSendButton(input, 4000).then(resolve);
    });
  }

  function waitForSendButton(input, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();

      function attempt() {
        // Try every send button selector
        for (const sel of SEND_BTN_SELECTORS) {
          const btn = document.querySelector(sel);
          if (btn) {
            btn.click();
            logToTerminal("info", "📨 Sent via button", { selector: sel });
            return resolve();
          }
        }

        if (Date.now() - start > timeoutMs) {
          logToTerminal("info", "📨 Sending via Enter key (button timeout)", {});
          input.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter", code: "Enter", keyCode: 13, which: 13,
            bubbles: true, cancelable: true,
          }));
          return resolve();
        }
        setTimeout(attempt, 120);
      }
      setTimeout(attempt, 200);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 8. SCANNER
  // ═══════════════════════════════════════════════════════════════════
  function scanForCalls() {
    if (!snapshotLocked) return;
    if (callInFlight)    return;
    if (getInputBoxText().includes("AGENT_CALL")) return;

    const calls = findAllCalls(getAllMessagesText());
    for (const rawJSON of calls) {
      const norm = normaliseJSON(rawJSON);
      if (OLD_CHAT_SNAPSHOT.has(norm)) continue;
      if (processedCalls.has(norm))    continue;
      processedCalls.add(norm);
      handleAgentCall(rawJSON);
      break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 9. TERMINAL PANEL
  // ═══════════════════════════════════════════════════════════════════
  let terminalPanel = null;
  let logContainer  = null;
  let isFullScreen  = false;
  let savedPos = { top: "20px", right: "20px", left: "auto", width: "440px", height: "560px" };

  // Message type styles — now includes user + ai types
  const TSTYLES = {
    request: { bg: "#1e1e2e", border: "#89b4fa", hBg: "#89b4fa22", c: "#89b4fa" },
    success: { bg: "#1b2b24", border: "#a6e3a1", hBg: "#a6e3a122", c: "#a6e3a1" },
    error:   { bg: "#2a1a1c", border: "#f38ba8", hBg: "#f38ba822", c: "#f38ba8" },
    info:    { bg: "#1e1e2e", border: "#cba6f7", hBg: "#cba6f722", c: "#cba6f7" },
    user:    { bg: "#1a1a2e", border: "#f9e2af", hBg: "#f9e2af22", c: "#f9e2af" },
    ai:      { bg: "#1a2a1a", border: "#94e2d5", hBg: "#94e2d522", c: "#94e2d5" },
  };

  function initializeTerminal() {
    if (document.getElementById("vbc-panel")) return;

    terminalPanel = document.createElement("div");
    terminalPanel.id = "vbc-panel";
    terminalPanel.style.cssText = `
      position:fixed;top:${savedPos.top};right:${savedPos.right};
      width:${savedPos.width};height:${savedPos.height};
      background:#1e1e2e;border:2px solid #313244;border-radius:12px;
      box-shadow:0 12px 32px rgba(0,0,0,.6);display:flex;flex-direction:column;
      font-family:'Consolas','Menlo','Monaco',monospace;
      z-index:999999;overflow:hidden;box-sizing:border-box;
    `;

    // ── Header ──────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.id = "vbc-header";
    header.style.cssText = `
      padding:0 12px;height:44px;background:#11111b;color:#cdd6f4;font-size:12px;
      font-weight:bold;display:flex;justify-content:space-between;align-items:center;
      cursor:move;user-select:none;border-bottom:1px solid #313244;flex-shrink:0;
    `;
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="color:#f38ba8;">⬤</span>
        <span style="color:#f9e2af;">⬤</span>
        <span style="color:#a6e3a1;">⬤</span>
        <span style="margin-left:6px;color:#a6adc8;font-size:11px;">VibesCode Console</span>
      </div>
      <div style="display:flex;gap:5px;align-items:center;">
        <button id="vbc-inspect-btn" title="Run DOM inspector to debug selectors"
          style="background:#313244;color:#f9e2af;border:none;border-radius:4px;
          padding:4px 8px;font-size:10px;cursor:pointer;">🔍 Inspect</button>
        <button id="vbc-clear-btn"
          style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;
          padding:4px 8px;font-size:10px;cursor:pointer;">🗑 Clear</button>
        <button id="vbc-export-btn"
          style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;
          padding:4px 8px;font-size:10px;cursor:pointer;">💾 Export</button>
        <button id="vbc-fs-btn"
          style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;
          padding:4px 10px;font-size:10px;cursor:pointer;font-weight:bold;">🗖</button>
      </div>
    `;

    // ── Status bar ──────────────────────────────────────────────────
    const statusBar = document.createElement("div");
    statusBar.id = "vbc-status";
    statusBar.style.cssText = `
      padding:4px 12px;background:#181825;border-bottom:1px solid #313244;
      font-size:10px;color:#6c7086;display:flex;gap:12px;flex-shrink:0;
    `;
    statusBar.innerHTML = `
      <span id="vbc-url">📍 ${location.hostname}</span>
      <span id="vbc-call-count">🔧 Calls: 0</span>
      <span id="vbc-status-text">⏳ Snapshotting…</span>
    `;

    // ── Filter tabs ─────────────────────────────────────────────────
    const tabs = document.createElement("div");
    tabs.style.cssText = `
      display:flex;gap:4px;padding:6px 12px;background:#181825;
      border-bottom:1px solid #313244;flex-shrink:0;
    `;
    tabs.innerHTML = `
      <button class="vbc-tab vbc-tab-active" data-filter="all"
        style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid #89b4fa;
        background:#89b4fa22;color:#89b4fa;cursor:pointer;">All</button>
      <button class="vbc-tab" data-filter="user"
        style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid #313244;
        background:transparent;color:#6c7086;cursor:pointer;">👤 User</button>
      <button class="vbc-tab" data-filter="ai"
        style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid #313244;
        background:transparent;color:#6c7086;cursor:pointer;">🤖 AI</button>
      <button class="vbc-tab" data-filter="tool"
        style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid #313244;
        background:transparent;color:#6c7086;cursor:pointer;">🔧 Tools</button>
    `;

    // ── Log area ────────────────────────────────────────────────────
    logContainer = document.createElement("div");
    logContainer.id = "vbc-logs";
    logContainer.style.cssText = `
      flex:1;min-height:0;padding:10px;background:#181825;overflow-y:auto;
      overflow-x:hidden;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;
    `;

    // ── Assemble ────────────────────────────────────────────────────
    terminalPanel.appendChild(header);
    terminalPanel.appendChild(statusBar);
    terminalPanel.appendChild(tabs);
    terminalPanel.appendChild(logContainer);
    document.body.appendChild(terminalPanel);

    // ── Events ──────────────────────────────────────────────────────
    makeDraggable(terminalPanel, header);

    document.getElementById("vbc-fs-btn")
      .addEventListener("click", toggleFullScreen);

    document.getElementById("vbc-inspect-btn")
      .addEventListener("click", (e) => { e.stopPropagation(); runDOMInspector(); });

    document.getElementById("vbc-clear-btn")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        logContainer.innerHTML = "";
        logToTerminal("info", "🗑 Console cleared", {});
      });

    document.getElementById("vbc-export-btn")
      .addEventListener("click", (e) => { e.stopPropagation(); exportLogs(); });

    // Filter tabs
    tabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".vbc-tab");
      if (!btn) return;
      const filter = btn.dataset.filter;
      currentFilter = filter;
      tabs.querySelectorAll(".vbc-tab").forEach(b => {
        const active = b === btn;
        b.style.borderColor  = active ? "#89b4fa" : "#313244";
        b.style.background   = active ? "#89b4fa22" : "transparent";
        b.style.color        = active ? "#89b4fa" : "#6c7086";
      });
      applyFilter(filter);
    });
  }

  // ── Filter ───────────────────────────────────────────────────────
  let currentFilter = "all";
  let callCount     = 0;

  function applyFilter(filter) {
    logContainer.querySelectorAll("[data-log-type]").forEach(el => {
      const t = el.dataset.logType;
      const show = filter === "all"
        || (filter === "user" && t === "user")
        || (filter === "ai"   && t === "ai")
        || (filter === "tool" && ["request","success","error"].includes(t));
      el.style.display = show ? "" : "none";
    });
  }

  function updateStatus(text) {
    const el = document.getElementById("vbc-status-text");
    if (el) el.textContent = text;
  }

  function updateCallCount() {
    callCount++;
    const el = document.getElementById("vbc-call-count");
    if (el) el.textContent = `🔧 Calls: ${callCount}`;
  }

  // ── Draggable ────────────────────────────────────────────────────
  function makeDraggable(el, handle) {
    let dragging = false, startX, startY, startLeft, startTop, rafId;
    let pendingX = 0, pendingY = 0;

    handle.addEventListener("mousedown", (e) => {
      if (isFullScreen || e.target.closest("button")) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const r = el.getBoundingClientRect();
      startLeft = r.left; startTop = r.top;
      el.style.right = "auto";
      el.style.left  = startLeft + "px";
      el.style.top   = startTop  + "px";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      pendingX = e.clientX; pendingY = e.clientY;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!dragging) return;
        const l = Math.max(0, Math.min(startLeft + pendingX - startX, window.innerWidth  - el.offsetWidth));
        const t = Math.max(0, Math.min(startTop  + pendingY - startY, window.innerHeight - el.offsetHeight));
        el.style.left = l + "px";
        el.style.top  = t + "px";
      });
    });
    document.addEventListener("mouseup", () => { dragging = false; });
  }

  function toggleFullScreen(e) {
    e.stopPropagation();
    const btn = document.getElementById("vbc-fs-btn");
    if (!isFullScreen) {
      savedPos = {
        top: terminalPanel.style.top, left: terminalPanel.style.left,
        right: terminalPanel.style.right, width: terminalPanel.style.width,
        height: terminalPanel.style.height,
      };
      Object.assign(terminalPanel.style, {
        top: "0", left: "0", right: "0",
        width: "100vw", height: "100vh", borderRadius: "0",
      });
      btn.textContent = "🗗";
      isFullScreen = true;
    } else {
      Object.assign(terminalPanel.style, { ...savedPos, borderRadius: "12px" });
      btn.textContent = "🗖";
      isFullScreen = false;
    }
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  // ── Log entry ────────────────────────────────────────────────────
  function logToTerminal(type, title, data) {
    initializeTerminal();
    const s = TSTYLES[type] || TSTYLES.info;

    // Collapse large data by default for tool results
    const isLarge   = JSON.stringify(data).length > 500;
    const collapsed = isLarge && ["success", "request"].includes(type);

    const el = document.createElement("div");
    el.dataset.logType = type;
    el.style.cssText = `
      width:100%;border-radius:6px;background:${s.bg};
      border:1px solid ${s.border};font-size:11px;overflow:hidden;flex-shrink:0;
    `;

    const headerDiv = document.createElement("div");
    headerDiv.style.cssText = `
      padding:6px 10px;background:${s.hBg};color:${s.c};
      font-weight:bold;display:flex;justify-content:space-between;
      align-items:center;cursor:${collapsed ? "pointer" : "default"};
    `;
    headerDiv.innerHTML = `
      <span>${title} ${collapsed ? "<span style='color:#6c7086;font-weight:normal'>(click to expand)</span>" : ""}</span>
      <span style="color:#6c7086;font-size:10px;">${new Date().toLocaleTimeString()}</span>
    `;

    const pre = document.createElement("pre");
    pre.style.cssText = `
      padding:10px;margin:0;white-space:pre-wrap;word-break:break-all;
      color:#cdd6f4;background:#11111b55;max-height:300px;overflow-y:auto;
      display:${collapsed ? "none" : "block"};
    `;
    pre.textContent = JSON.stringify(data, null, 2);

    if (collapsed) {
      headerDiv.addEventListener("click", () => {
        const hidden = pre.style.display === "none";
        pre.style.display = hidden ? "block" : "none";
        headerDiv.querySelector("span span").textContent =
          hidden ? "(click to collapse)" : "(click to expand)";
      });
    }

    el.appendChild(headerDiv);
    el.appendChild(pre);
    logContainer.appendChild(el);
    logContainer.scrollTop = logContainer.scrollHeight;

    // Apply current filter
    if (currentFilter !== "all") applyFilter(currentFilter);

    // Update status bar
    if (type === "request") { updateStatus(`🔧 Running: ${title}`); updateCallCount(); }
    if (type === "success") { updateStatus(`✅ Done`); }
    if (type === "error")   { updateStatus(`❌ Error — check logs`); }
    if (snapshotLocked && type === "info" && title.includes("Snapshot")) {
      updateStatus("✅ Ready");
    }
  }

  // ── Waiting banner ───────────────────────────────────────────────
  let bannerN = 0;

  function showWaitingBanner(op) {
    initializeTerminal();
    if (!document.getElementById("vbc-pulse")) {
      const s = document.createElement("style");
      s.id = "vbc-pulse";
      s.textContent = `@keyframes vbc-p{from{opacity:1}to{opacity:.3}}`;
      document.head.appendChild(s);
    }
    const id = `vbc-wait-${bannerN++}`;
    const b  = document.createElement("div");
    b.id = id;
    b.dataset.logType = "request";
    b.style.cssText = `
      width:100%;padding:8px 12px;background:#2a2a3e;
      border:1px dashed #f9e2af;border-radius:6px;color:#f9e2af;font-size:11px;
      display:flex;align-items:center;gap:8px;flex-shrink:0;
      animation:vbc-p 0.9s infinite alternate;
    `;
    b.innerHTML = `<span style="font-size:15px;">⏳</span><span>Calling <strong>${op}</strong>…</span>`;
    logContainer.appendChild(b);
    logContainer.scrollTop = logContainer.scrollHeight;
    return id;
  }

  function removeWaitingBanner(id) {
    document.getElementById(id)?.remove();
  }

  // ── Export ───────────────────────────────────────────────────────
  function exportLogs() {
    const entries = [];
    logContainer.querySelectorAll("[data-log-type]").forEach(el => {
      entries.push({
        type:  el.dataset.logType,
        title: el.querySelector("span")?.textContent,
        data:  el.querySelector("pre")?.textContent,
        time:  el.querySelector("[style*='10px']")?.textContent,
      });
    });
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), {
      href: url, download: `vibescode-${Date.now()}.json`,
    }).click();
    URL.revokeObjectURL(url);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 10. BOOT
  // ═══════════════════════════════════════════════════════════════════
  initializeTerminal();
  logToTerminal("info", "🚀 VibesCode v7 loaded", { site: location.hostname });

  // Scan for tool calls
  setInterval(scanForCalls, SCAN_INTERVAL);

  // Scan for new messages to show in console
  setInterval(scanMessages, 2000);

  // MutationObserver for real-time scanning
  setTimeout(() => {
    const root =
      document.querySelector('[data-testid="conversation-turn-list"]') ||
      document.querySelector("chat-history") ||
      document.querySelector("main") ||
      document.body;

    new MutationObserver(() => {
      if (!callInFlight) scanForCalls();
    }).observe(root, { childList: true, subtree: true, characterData: true });

    // Run inspector automatically on load so student sees what works
    setTimeout(runDOMInspector, 2000);
  }, 800);

  // Update status when snapshot locks
  const origSnap = tryBuildSnapshot;
  (function watchSnapshot() {
    if (snapshotLocked) {
      updateStatus("✅ Ready — watching for AGENT_CALL");
    } else {
      setTimeout(watchSnapshot, 500);
    }
  })();

  console.log("[VibesCode v7] Loaded on", location.hostname);

})();