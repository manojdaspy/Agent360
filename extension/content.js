// content.js — VibesCode Agent v8
// Clean rewrite: zero duplicates · platform-aware selectors · single MutationObserver
(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════
  // 0.  PLATFORM CONFIG
  //
  //     One entry per supported site.
  //     Only ONE selector per role — the most specific leaf node.
  //     Parent/child selectors must never coexist (causes duplicates).
  //
  //     To add a new platform:
  //       1. Add a new entry to PLATFORMS
  //       2. Set hostname to match location.hostname
  //       3. Open DevTools → inspect a message bubble → copy selector
  //
  //     To fix a broken selector:
  //       1. Click 🔍 Inspect in the console
  //       2. Find the ❌ line
  //       3. Right-click the element in DevTools → Copy → Copy selector
  //       4. Update the selector here
  // ═══════════════════════════════════════════════════════════════════
  const PLATFORMS = [
    {
      name:       "ChatGPT",
      match:      h => h.includes("chatgpt.com") || h.includes("chat.openai.com"),
      // Each turn is an <article data-testid="conversation-turn-N">
      // User text lives in a div with data-message-author-role="user"
      // AI text lives in a div with data-message-author-role="assistant"
      userMsg:    '[data-message-author-role="user"] .whitespace-pre-wrap',
      aiMsg:      '[data-message-author-role="assistant"] .markdown',
      input:      '#prompt-textarea',
      sendBtn:    '[data-testid="send-button"]:not([disabled])',
      chatRoot:   'main',
    },
    {
      name:       "Claude",
      match:      h => h.includes("claude.ai"),
      userMsg:    '[data-testid="user-message"]',
      aiMsg:      '[data-testid="assistant-message"] .whitespace-pre-wrap',
      input:      'div[contenteditable="true"]',
      sendBtn:    'button[aria-label="Send message"]:not([disabled])',
      chatRoot:   '[data-testid="conversation-turn-list"]',
    },
    {
      name:       "Gemini",
      match:      h => h.includes("gemini.google.com"),
      // Gemini uses web components. The deepest stable text node:
      userMsg:    'user-query .query-text',
      aiMsg:      'model-response .markdown',
      input:      'rich-textarea div[contenteditable="true"]',
      sendBtn:    'button.send-button:not([disabled])',
      chatRoot:   'chat-history',
    },
    {
      name:       "Perplexity",
      match:      h => h.includes("perplexity.ai"),
      userMsg:    '[data-testid="user-message"]',
      aiMsg:      '.prose',
      input:      'textarea',
      sendBtn:    'button[aria-label="Submit"]:not([disabled])',
      chatRoot:   'main',
    },
    {
      // Generic fallback — works on most chat UIs
      name:       "Generic",
      match:      () => true,
      userMsg:    '.user-message, .human-turn, [class*="user-turn"]',
      aiMsg:      '.assistant-message, .bot-message, [class*="assistant-turn"]',
      input:      'div[contenteditable="true"], textarea',
      sendBtn:    'button[type="submit"]:not([disabled])',
      chatRoot:   'main, body',
    },
  ];

  // Detect platform once at load
  const PLATFORM = PLATFORMS.find(p => p.match(location.hostname));
  console.log("[VibesCode v8] Platform:", PLATFORM.name);

  // ═══════════════════════════════════════════════════════════════════
  // 1.  CONSTANTS
  // ═══════════════════════════════════════════════════════════════════
  const SCAN_INTERVAL   = 800;
  const TOOL_TIMEOUT_MS = 30_000;
  const KEYWORD_RE      = /_*AGENT_CALL_*/g;

  // ═══════════════════════════════════════════════════════════════════
  // 2.  DOM HELPERS
  // ═══════════════════════════════════════════════════════════════════
  function $(sel, root = document) {
    return root.querySelector(sel);
  }
  function $$(sel, root = document) {
    try { return [...root.querySelectorAll(sel)]; }
    catch (_) { return []; }
  }

  function getInputBox() {
    // Try platform-specific first, then fallback through generic options
    return $(PLATFORM.input) ||
           $('div[contenteditable="true"]') ||
           $('textarea');
  }

  function getInputBoxText() {
    const el = getInputBox();
    return el ? (el.innerText || el.value || "").trim() : "";
  }

  function getSendButton() {
    // Try platform selector, then generic fallbacks
    return $(PLATFORM.sendBtn) ||
           $('button[aria-label="Send message"]:not([disabled])') ||
           $('button[aria-label="Send"]:not([disabled])') ||
           $('[data-testid="send-button"]:not([disabled])');
  }

  function getChatRoot() {
    return $(PLATFORM.chatRoot) || $('main') || document.body;
  }

  // ── Returns text of ALL sent messages (user + AI) for tool-call scanning ──
  function getAllSentText() {
    const seen = new WeakSet();
    let text = "";

    const collect = (sel) => {
      $$(sel).forEach(el => {
        if (seen.has(el)) return;
        // Never read the live input box
        const inp = getInputBox();
        if (inp && (el === inp || inp.contains(el) || el.contains(inp))) return;
        seen.add(el);
        text += (el.innerText || "") + "\n";
      });
    };

    collect(PLATFORM.userMsg);
    collect(PLATFORM.aiMsg);
    return text;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3.  DEDUPLICATION REGISTRY
  //
  //     Each DOM element is logged AT MOST ONCE per "generation".
  //     A generation is cleared when the page navigates (SPA route change).
  //
  //     We use a WeakSet so GC'd nodes don't leak memory.
  // ═══════════════════════════════════════════════════════════════════
  let loggedNodes = new WeakSet();   // elements already sent to terminal
  let loggedTexts = new Set();       // text strings already logged (catches re-renders)

  // Reset on SPA navigation
  let lastPathname = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPathname) {
      lastPathname  = location.pathname;
      loggedNodes   = new WeakSet();
      loggedTexts   = new Set();
      logToTerminal("info", "🔄 Navigation detected", { path: location.pathname });
    }
  }, 1000);

  // ═══════════════════════════════════════════════════════════════════
  // 4.  LIVE MESSAGE SCANNER
  //     Called by MutationObserver. Logs each new message ONCE.
  // ═══════════════════════════════════════════════════════════════════
  function scanNewMessages() {
    // ── User messages ───────────────────────────────────────────────
    $$(PLATFORM.userMsg).forEach(el => {
      if (loggedNodes.has(el)) return;
      const text = el.innerText?.trim();
      if (!text || text.length < 2) return;
      // Skip if we've seen this exact text (handles re-renders of same node)
      if (loggedTexts.has("u:" + text)) return;

      loggedNodes.add(el);
      loggedTexts.add("u:" + text);
      logToTerminal("user", "👤 You", { message: text });
    });

    // ── AI messages ─────────────────────────────────────────────────
    $$(PLATFORM.aiMsg).forEach(el => {
      if (loggedNodes.has(el)) return;
      const text = el.innerText?.trim();
      if (!text || text.length < 2) return;
      if (text.includes("AGENT_CALL")) return;   // skip tool-call turns
      if (text.includes("__TOOL_RESULT__")) return;
      if (loggedTexts.has("a:" + text)) return;

      loggedNodes.add(el);
      loggedTexts.add("a:" + text);
      logToTerminal("ai", "🤖 AI", {
        message: text.length > 400 ? text.slice(0, 400) + "…" : text
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 5.  JSON EXTRACTOR (brace-balanced, never grabs prose)
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
    try { return JSON.parse(s); }             catch (_) {}
    try { return JSON.parse("{" + s + "}"); } catch (_) {}
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 6.  OLD-CHAT SNAPSHOT (SPA-safe, waits for stable DOM)
  // ═══════════════════════════════════════════════════════════════════
  const OLD_CHAT_SNAPSHOT = new Set();
  let snapshotLocked   = false;
  let lastSnapshotHash = "";
  let snapshotAttempts = 0;

  function tryBuildSnapshot() {
    if (snapshotLocked) return;
    const calls = findAllCalls(getAllSentText());
    const hash  = calls.map(normaliseJSON).join("|");

    if (hash !== "" && hash === lastSnapshotHash) {
      calls.forEach(c => OLD_CHAT_SNAPSHOT.add(normaliseJSON(c)));
      snapshotLocked = true;
      updateStatus("✅ Ready");
      logToTerminal("info", "📸 Snapshot locked",
        { oldCalls: OLD_CHAT_SNAPSHOT.size });
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
        updateStatus("✅ Ready");
        logToTerminal("info", "📸 Fresh page — watching for calls", {});
      }
    }
  }, 400);

  // ═══════════════════════════════════════════════════════════════════
  // 7.  BLOCKING TOOL-CALL HANDLER
  // ═══════════════════════════════════════════════════════════════════
  const processedCalls = new Set();
  let   callInFlight   = false;
  let   callCount      = 0;

  async function handleAgentCall(rawJSON) {
    if (callInFlight) return;
    callInFlight = true;

    const parsed = safeParseJSON(rawJSON);
    if (!parsed) {
      logToTerminal("error", "⚠️ Parse error",
        { raw: rawJSON, hint: "Could not extract valid JSON" });
      callInFlight = false;
      return;
    }

    const { op, ...params } = parsed;
    callCount++;
    updateCallCount(callCount);
    updateStatus(`🔧 Running: ${op}`);
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
      updateStatus("✅ Done");
      logToTerminal("success", `✅ RESULT: ${op.toUpperCase()}`, result);
    } else {
      updateStatus("❌ Error");
      logToTerminal("error", `❌ FAILED: ${op.toUpperCase()}`, result);
    }

    await injectToolResult(op, result);
    callInFlight = false;
  }

  function sendToBackground(op, params) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "AGENT_CALL", op, params }, (res) => {
        if (chrome.runtime.lastError)
          reject(new Error(chrome.runtime.lastError.message));
        else
          resolve(res?.result || { ok: false, error: "No response from background" });
      });
    });
  }

  function rejectAfter(ms) {
    return new Promise((_, r) =>
      setTimeout(() => r(new Error(`Timeout after ${ms / 1000}s`)), ms));
  }

  // ═══════════════════════════════════════════════════════════════════
  // 8.  INJECT TOOL RESULT → AI INPUT BOX
  // ═══════════════════════════════════════════════════════════════════
  function injectToolResult(op, result) {
    return new Promise((resolve) => {
      const text =
        `__TOOL_RESULT__\nop: ${op}\n` +
        JSON.stringify(result, null, 2) +
        `\n__END_RESULT__\n\nContinue based on the result above.`;

      const input = getInputBox();
      if (!input) {
        logToTerminal("error", "⚠️ No input box found",
          { platform: PLATFORM.name, selector: PLATFORM.input });
        return resolve();
      }

      input.focus();

      // Strategy A — React-managed <textarea> (ChatGPT)
      if (input.tagName === "TEXTAREA") {
        const proto    = window.HTMLTextAreaElement.prototype;
        const nativeFn = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (nativeFn) nativeFn.call(input, text);
        else input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));

      // Strategy B — contenteditable div (Gemini, Claude)
      } else {
        const sel   = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.removeAllRanges();
        sel.addRange(range);

        const ok = document.execCommand("insertText", false, text);
        if (!ok) {
          // Strategy C — direct assignment (last resort)
          input.innerText = text;
          input.dispatchEvent(new InputEvent("input", {
            bubbles: true, data: text, inputType: "insertText",
          }));
        }
      }

      logToTerminal("info", "✏️ Result injected into input", {
        platform: PLATFORM.name,
        chars:    text.length,
      });

      waitForSendButton(input, 4000).then(resolve);
    });
  }

  function waitForSendButton(input, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + 12000;

      function attempt() {
        if (isBotGenerating()) {          // ← add this check
          setTimeout(attempt, 500);
          return;
        }
        const btn = getSendButton();
        if (btn) {
          btn.click();
          logToTerminal("info", "📨 Sent to AI", { platform: PLATFORM.name });
          return resolve();
        }
        if (Date.now() > deadline) {
          // Enter-key fallback
          input.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter", code: "Enter", keyCode: 13,
            which: 13, bubbles: true, cancelable: true,
          }));
          logToTerminal("info", "📨 Sent via Enter key (button timeout)", {});
          return resolve();
        }
        setTimeout(attempt, 120);
      }
      setTimeout(attempt, 200);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 9.  TOOL-CALL SCANNER (reads sent messages only)
  // ═══════════════════════════════════════════════════════════════════
  function scanForCalls() {
    if (!snapshotLocked)                           return;
    if (callInFlight)                              return;
    if (getInputBoxText().includes("AGENT_CALL"))  return;

    for (const rawJSON of findAllCalls(getAllSentText())) {
      const norm = normaliseJSON(rawJSON);
      if (OLD_CHAT_SNAPSHOT.has(norm)) continue;
      if (processedCalls.has(norm))    continue;
      processedCalls.add(norm);
      handleAgentCall(rawJSON);
      break; // one call at a time (blocking)
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 10. DOM INSPECTOR  (🔍 button)
  // ═══════════════════════════════════════════════════════════════════
  function runDOMInspector() {
    const report = { platform: PLATFORM.name };

    const check = (label, sel) => {
      if (!sel) { report[`❌ ${label}`] = "No selector defined"; return; }
      try {
        const els = document.querySelectorAll(sel);
        if (els.length) report[`✅ ${label} (${els.length})`] = sel;
        else            report[`❌ ${label}`]                  = `0 matches: ${sel}`;
      } catch (e) {
        report[`❌ ${label} (invalid)`] = sel;
      }
    };

    check("Input box",    PLATFORM.input);
    check("Send button",  PLATFORM.sendBtn.replace(":not([disabled])", ""));
    check("User messages", PLATFORM.userMsg);
    check("AI messages",   PLATFORM.aiMsg);
    check("Chat root",     PLATFORM.chatRoot);

    // Dump custom web-components found on page
    const webComponents = new Set();
    document.querySelectorAll("*").forEach(el => {
      if (el.tagName.includes("-")) webComponents.add(el.tagName.toLowerCase());
    });
    report["🧩 Web components"] = [...webComponents].join(", ") || "none";

    logToTerminal("info", `🔍 DOM Report — ${PLATFORM.name}`, report);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 11. TERMINAL PANEL
  // ═══════════════════════════════════════════════════════════════════
  let terminalPanel = null;
  let logContainer  = null;
  let isFullScreen  = false;
  let savedPos = { top:"20px", right:"20px", left:"auto",
                   width:"440px", height:"560px" };

  const TSTYLES = {
    request: { bg:"#1e1e2e", border:"#89b4fa", hBg:"#89b4fa22", c:"#89b4fa" },
    success: { bg:"#1b2b24", border:"#a6e3a1", hBg:"#a6e3a122", c:"#a6e3a1" },
    error:   { bg:"#2a1a1c", border:"#f38ba8", hBg:"#f38ba822", c:"#f38ba8" },
    info:    { bg:"#1e1e2e", border:"#cba6f7", hBg:"#cba6f722", c:"#cba6f7" },
    user:    { bg:"#1a1a2e", border:"#f9e2af", hBg:"#f9e2af22", c:"#f9e2af" },
    ai:      { bg:"#1a2a1a", border:"#94e2d5", hBg:"#94e2d522", c:"#94e2d5" },
  };

  let currentFilter = "all";

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

    // Header
    const header = document.createElement("div");
    header.id = "vbc-header";
    header.style.cssText = `
      padding:0 12px;height:44px;background:#11111b;color:#cdd6f4;
      display:flex;justify-content:space-between;align-items:center;
      cursor:move;user-select:none;border-bottom:1px solid #313244;flex-shrink:0;
    `;
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="color:#f38ba8;font-size:10px;">⬤</span>
        <span style="color:#f9e2af;font-size:10px;">⬤</span>
        <span style="color:#a6e3a1;font-size:10px;">⬤</span>
        <span style="margin-left:4px;color:#a6adc8;font-size:11px;font-weight:bold;">
          VibesCode</span>
        <span id="vbc-platform-badge" style="
          font-size:9px;padding:2px 6px;border-radius:10px;
          background:#313244;color:#cba6f7;margin-left:4px;">
          ${PLATFORM.name}</span>
      </div>
      <div style="display:flex;gap:4px;align-items:center;">
        <button id="vbc-inspect-btn" style="
          background:#313244;color:#f9e2af;border:none;border-radius:4px;
          padding:3px 7px;font-size:10px;cursor:pointer;" title="Run DOM inspector">
          🔍</button>
        <button id="vbc-clear-btn" style="
          background:#313244;color:#cdd6f4;border:none;border-radius:4px;
          padding:3px 7px;font-size:10px;cursor:pointer;">🗑</button>
        <button id="vbc-export-btn" style="
          background:#313244;color:#cdd6f4;border:none;border-radius:4px;
          padding:3px 7px;font-size:10px;cursor:pointer;">💾</button>
        <button id="vbc-fs-btn" style="
          background:#313244;color:#cdd6f4;border:none;border-radius:4px;
          padding:3px 9px;font-size:10px;cursor:pointer;font-weight:bold;">🗖</button>
      </div>
    `;

    // Status bar
    const statusBar = document.createElement("div");
    statusBar.style.cssText = `
      padding:3px 12px;background:#11111b;border-bottom:1px solid #1e1e2e;
      font-size:10px;color:#6c7086;display:flex;justify-content:space-between;
      flex-shrink:0;
    `;
    statusBar.innerHTML = `
      <span id="vbc-status-text">⏳ Snapshotting…</span>
      <span id="vbc-call-count">🔧 0 calls</span>
    `;

    // Filter tabs
    const tabs = document.createElement("div");
    tabs.id = "vbc-tabs";
    tabs.style.cssText = `
      display:flex;gap:4px;padding:6px 10px;background:#181825;
      border-bottom:1px solid #313244;flex-shrink:0;
    `;
    const TAB_DEFS = [
      { filter:"all",     label:"All"        },
      { filter:"user",    label:"👤 User"    },
      { filter:"ai",      label:"🤖 AI"      },
      { filter:"tool",    label:"🔧 Tools"   },
    ];
    TAB_DEFS.forEach(({ filter, label }) => {
      const btn = document.createElement("button");
      btn.dataset.filter = filter;
      btn.textContent    = label;
      btn.style.cssText  = `
        font-size:10px;padding:3px 8px;border-radius:4px;cursor:pointer;
        border:1px solid #313244;background:transparent;color:#6c7086;
      `;
      if (filter === "all") setTabActive(btn);
      tabs.appendChild(btn);
    });

    // Log area
    logContainer = document.createElement("div");
    logContainer.id = "vbc-logs";
    logContainer.style.cssText = `
      flex:1;min-height:0;padding:10px;background:#181825;
      overflow-y:auto;overflow-x:hidden;
      display:flex;flex-direction:column;gap:8px;box-sizing:border-box;
    `;

    terminalPanel.appendChild(header);
    terminalPanel.appendChild(statusBar);
    terminalPanel.appendChild(tabs);
    terminalPanel.appendChild(logContainer);
    document.body.appendChild(terminalPanel);

    // Events
    makeDraggable(terminalPanel, header);

    document.getElementById("vbc-fs-btn")
      .addEventListener("click", (e) => { e.stopPropagation(); toggleFullScreen(); });
    document.getElementById("vbc-inspect-btn")
      .addEventListener("click", (e) => { e.stopPropagation(); runDOMInspector(); });
    document.getElementById("vbc-clear-btn")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        logContainer.innerHTML = "";
      });
    document.getElementById("vbc-export-btn")
      .addEventListener("click", (e) => { e.stopPropagation(); exportLogs(); });

    tabs.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-filter]");
      if (!btn) return;
      currentFilter = btn.dataset.filter;
      tabs.querySelectorAll("button[data-filter]").forEach(b => {
        if (b === btn) setTabActive(b); else setTabInactive(b);
      });
      applyFilter(currentFilter);
    });
  }

  function setTabActive(btn) {
    btn.style.borderColor = "#89b4fa";
    btn.style.background  = "#89b4fa22";
    btn.style.color       = "#89b4fa";
  }
  function setTabInactive(btn) {
    btn.style.borderColor = "#313244";
    btn.style.background  = "transparent";
    btn.style.color       = "#6c7086";
  }

  function applyFilter(filter) {
    logContainer.querySelectorAll("[data-log-type]").forEach(el => {
      const t = el.dataset.logType;
      const show =
        filter === "all" ||
        (filter === "user" && t === "user") ||
        (filter === "ai"   && t === "ai") ||
        (filter === "tool" && ["request","success","error"].includes(t));
      el.style.display = show ? "" : "none";
    });
  }

  function updateStatus(text) {
    const el = document.getElementById("vbc-status-text");
    if (el) el.textContent = text;
  }
  function updateCallCount(n) {
    const el = document.getElementById("vbc-call-count");
    if (el) el.textContent = `🔧 ${n} call${n !== 1 ? "s" : ""}`;
  }

  // ── Smooth drag ──────────────────────────────────────────────────
  function makeDraggable(el, handle) {
    let dragging=false, startX, startY, startLeft, startTop, rafId;
    let pendingX=0, pendingY=0;

    handle.addEventListener("mousedown", (e) => {
      if (isFullScreen || e.target.closest("button")) return;
      dragging=true; startX=e.clientX; startY=e.clientY;
      const r=el.getBoundingClientRect();
      startLeft=r.left; startTop=r.top;
      el.style.right="auto";
      el.style.left=startLeft+"px"; el.style.top=startTop+"px";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      pendingX=e.clientX; pendingY=e.clientY;
      if (rafId) return;
      rafId=requestAnimationFrame(() => {
        rafId=null; if (!dragging) return;
        const l=Math.max(0,Math.min(startLeft+pendingX-startX,window.innerWidth -el.offsetWidth));
        const t=Math.max(0,Math.min(startTop +pendingY-startY,window.innerHeight-el.offsetHeight));
        el.style.left=l+"px"; el.style.top=t+"px";
      });
    });
    document.addEventListener("mouseup", () => { dragging=false; });
  }

  function toggleFullScreen() {
    const btn=document.getElementById("vbc-fs-btn");
    if (!isFullScreen) {
      savedPos={top:terminalPanel.style.top,left:terminalPanel.style.left,
        right:terminalPanel.style.right,width:terminalPanel.style.width,
        height:terminalPanel.style.height};
      Object.assign(terminalPanel.style,{
        top:"0",left:"0",right:"0",width:"100vw",height:"100vh",borderRadius:"0"});
      btn.textContent="🗗"; isFullScreen=true;
    } else {
      Object.assign(terminalPanel.style,{...savedPos,borderRadius:"12px"});
      btn.textContent="🗖"; isFullScreen=false;
    }
    logContainer.scrollTop=logContainer.scrollHeight;
  }

  function isBotGenerating() {
  // Gemini shows a stop button while generating
  return !!(
    document.querySelector('button[aria-label="Stop response"]') ||
    document.querySelector('.stop-button') ||
    document.querySelector('[data-testid="stop-button"]')
  );
}

  // ── Log entry renderer ───────────────────────────────────────────
  function logToTerminal(type, title, data) {
    initializeTerminal();
    const s = TSTYLES[type] || TSTYLES.info;

    const isLarge   = JSON.stringify(data).length > 600;
    const collapsed = isLarge && ["success","request"].includes(type);

    const el = document.createElement("div");
    el.dataset.logType = type;
    el.style.cssText = `
      width:100%;border-radius:6px;background:${s.bg};
      border:1px solid ${s.border};font-size:11px;overflow:hidden;flex-shrink:0;
    `;

    const hdr = document.createElement("div");
    hdr.style.cssText = `
      padding:5px 10px;background:${s.hBg};color:${s.c};font-weight:bold;
      display:flex;justify-content:space-between;align-items:center;
      cursor:${collapsed ? "pointer" : "default"};
    `;
    hdr.innerHTML = `
      <span>${title}${collapsed
        ? ' <span style="color:#6c7086;font-size:9px;font-weight:normal">(expand)</span>'
        : ""}</span>
      <span style="color:#6c7086;font-size:10px;">${new Date().toLocaleTimeString()}</span>
    `;

    const pre = document.createElement("pre");
    pre.style.cssText = `
      padding:8px 10px;margin:0;white-space:pre-wrap;word-break:break-all;
      color:#cdd6f4;background:#11111b55;max-height:280px;overflow-y:auto;
      display:${collapsed ? "none" : "block"};font-size:11px;
    `;
    pre.textContent = JSON.stringify(data, null, 2);

    if (collapsed) {
      hdr.addEventListener("click", () => {
        const show = pre.style.display === "none";
        pre.style.display = show ? "block" : "none";
        const hint = hdr.querySelector("span span");
        if (hint) hint.textContent = show ? "(collapse)" : "(expand)";
      });
    }

    el.appendChild(hdr);
    el.appendChild(pre);
    logContainer.appendChild(el);
    logContainer.scrollTop = logContainer.scrollHeight;

    if (currentFilter !== "all") applyFilter(currentFilter);
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
    b.id = id; b.dataset.logType = "request";
    b.style.cssText = `
      width:100%;padding:7px 12px;background:#2a2a3e;
      border:1px dashed #f9e2af;border-radius:6px;color:#f9e2af;
      font-size:11px;display:flex;align-items:center;gap:8px;flex-shrink:0;
      animation:vbc-p 0.9s infinite alternate;
    `;
    b.innerHTML = `<span>⏳</span><span>Calling <strong>${op}</strong>…</span>`;
    logContainer.appendChild(b);
    logContainer.scrollTop = logContainer.scrollHeight;
    return id;
  }
  function removeWaitingBanner(id) { document.getElementById(id)?.remove(); }

  // ── Export ───────────────────────────────────────────────────────
  function exportLogs() {
    const rows = [];
    logContainer.querySelectorAll("[data-log-type]").forEach(el => {
      rows.push({
        type:  el.dataset.logType,
        title: el.querySelector("span")?.textContent?.trim(),
        data:  (() => { try { return JSON.parse(el.querySelector("pre")?.textContent || "{}"); } catch { return {}; } })(),
        time:  el.querySelector("[style*='font-size:10px']")?.textContent,
      });
    });
    const blob = new Blob([JSON.stringify(rows, null, 2)], {type:"application/json"});
    const url  = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"),
      { href:url, download:`vibescode-${Date.now()}.json` }).click();
    URL.revokeObjectURL(url);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 12. BOOT — single MutationObserver does everything
  // ═══════════════════════════════════════════════════════════════════
  initializeTerminal();
  logToTerminal("info", "🚀 VibesCode v8", { platform: PLATFORM.name, url: location.hostname });

  // Periodic tool-call scan (backup for slow-rendering pages)
  setInterval(scanForCalls, SCAN_INTERVAL);

  // Boot observer after DOM settles
  setTimeout(() => {
    const root = getChatRoot();

    // ONE observer, handles both message logging AND tool-call scanning
    new MutationObserver(() => {
      scanNewMessages();          // log new Q&A pairs (deduped)
      if (!callInFlight) scanForCalls();  // check for AGENT_CALL markers
    }).observe(root, { childList:true, subtree:true, characterData:true });

    logToTerminal("info", "👁 Watching", { root: root.tagName + (root.id ? "#"+root.id : "") });

    // Auto-inspect on load so selectors are visible immediately
    setTimeout(runDOMInspector, 1500);
  }, 800);

  console.log("[VibesCode v8] Loaded on", location.hostname, "| Platform:", PLATFORM.name);
})();
