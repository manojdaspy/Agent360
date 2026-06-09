// content.js  — VibesCode Agent  (v3)
// Fix: scanner only reads SENT messages, never the input box
(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════
  // 0.  CONSTANTS
  // ═══════════════════════════════════════════════════════════════════
  const SCAN_INTERVAL   = 600;
  const TOOL_TIMEOUT_MS = 30_000;
  const CALL_PATTERN    = /__AGENT_CALL__([\s\S]*?)__END__/g;

  // ═══════════════════════════════════════════════════════════════════
  // 1.  INPUT-BOX REGISTRY
  //     Keep a live reference to every input element on the page.
  //     The scanner will SKIP text that comes from these elements.
  // ═══════════════════════════════════════════════════════════════════
  const inputElements = new WeakSet();

  // Find input elements and register them
  function registerInputs() {
    const candidates = [
      ...document.querySelectorAll('div[contenteditable="true"]'),
      ...document.querySelectorAll("textarea"),
    ];
    candidates.forEach(el => inputElements.add(el));
  }

  // Poll for late-appearing inputs (SPAs render inputs after load)
  setInterval(registerInputs, 1000);
  registerInputs();

  // ── Helper: get the raw text of the input box right now ─────────────────
  function getInputBoxText() {
    const el =
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector("textarea");
    if (!el) return "";
    return (el.innerText || el.value || "").trim();
  }

  // ═══════════════════════════════════════════════════════════════════
  // 2.  OLD-CHAT IMMUNITY
  //     Snapshot all __AGENT_CALL__ payloads already in DOM at load time.
  //     These are from previous conversations — never process them again.
  // ═══════════════════════════════════════════════════════════════════
  const OLD_CHAT_SNAPSHOT = new Set();

  function buildOldSnapshot() {
    // Read only SENT message containers, not the input box
    const sentText = getSentMessagesText();
    let m;
    const re = /__AGENT_CALL__([\s\S]*?)__END__/g;
    while ((m = re.exec(sentText)) !== null) {
      OLD_CHAT_SNAPSHOT.add(m[1].trim());
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3.  SENT-MESSAGE TEXT EXTRACTOR
  //
  //     THE KEY FIX:
  //     Instead of document.body.innerText (which includes the input box),
  //     we query only the rendered chat message containers.
  //     The input box is never read by the scanner.
  // ═══════════════════════════════════════════════════════════════════
  const MESSAGE_SELECTORS = [
    // Claude.ai — both human and assistant turns
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    // ChatGPT
    '[data-message-author-role]',
    // Gemini
    'user-query',
    'model-response',
    // Generic fallbacks
    '.human-turn',
    '.assistant-turn',
    '.chat-message',
    '.message-content',
  ];

  function getSentMessagesText() {
    let text = "";
    for (const sel of MESSAGE_SELECTORS) {
      const els = document.querySelectorAll(sel);
      els.forEach(el => {
        // Double-check: never read an input box even if it matches
        if (inputElements.has(el)) return;
        if (el.isContentEditable && el.tagName !== "P") return; // skip editable divs
        text += (el.innerText || "") + "\n";
      });
    }
    return text;
  }

  // Run snapshot AFTER DOM is stable (50ms gives SPAs time to paint)
  setTimeout(() => {
    buildOldSnapshot();
    console.log("[VibesCode v3] Old-chat snapshot size:", OLD_CHAT_SNAPSHOT.size);
  }, 50);

  // ═══════════════════════════════════════════════════════════════════
  // 4.  CONVERSATION STORE  { pairs: [{human, ai}, ...] }
  // ═══════════════════════════════════════════════════════════════════
  const conversationStore = { pairs: [] };
  let   pendingHuman      = null;

  function storePair(human, ai) {
    conversationStore.pairs.push({ human, ai });
    window.__vibesConversation = conversationStore;
    logToTerminal("info", "💬 Conversation stored",
      conversationStore.pairs[conversationStore.pairs.length - 1]);
  }

  // ─── 4a. Watch user submit ───────────────────────────────────────────────
  function attachInputWatcher() {
    const tryAttach = setInterval(() => {
      const input =
        document.querySelector('div[contenteditable="true"]') ||
        document.querySelector("textarea#prompt-textarea") ||
        document.querySelector("textarea");
      if (!input) return;
      clearInterval(tryAttach);
      inputElements.add(input);

      // Capture text on Enter keydown (before the box clears)
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.shiftKey) return;
        const text = (input.innerText || input.value || "").trim();
        if (text) pendingHuman = text;
      }, true);

      // Capture text on send-button click
      document.addEventListener("click", (e) => {
        const btn = e.target.closest(
          'button[aria-label="Send message"],' +
          'button[data-testid="send-button"],' +
          'button[type="submit"]'
        );
        if (!btn) return;
        const text = (input.innerText || input.value || "").trim();
        if (text) pendingHuman = text;
      }, true);

    }, 800);
  }

  // ─── 4b. Watch AI finish responding ──────────────────────────────────────
  function watchForAIResponse() {
    let timer = null;
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!pendingHuman) return;
        const aiText = getLatestAIMessage();
        if (!aiText) return;
        storePair(pendingHuman, aiText);
        pendingHuman = null;
      }, 1500);
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function getLatestAIMessage() {
    const selectors = [
      '[data-testid="assistant-message"] .whitespace-pre-wrap',
      '[data-message-author-role="assistant"] .markdown',
      'model-response .response-content',
      '.assistant-message',
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length) return els[els.length - 1].innerText?.trim() || null;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 5.  BLOCKING TOOL-CALL HANDLER
  // ═══════════════════════════════════════════════════════════════════
  const processedCalls = new Set();
  let   callInFlight   = false;

  async function handleAgentCall(raw) {
    if (callInFlight) return;
    callInFlight = true;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      logToTerminal("error", "⚠️ Parse error", { raw, error: e.message });
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

    if (result.ok || result.success) {
      logToTerminal("success", `✅ RESULT: ${op.toUpperCase()}`, result);
    } else {
      logToTerminal("error", `❌ FAILED: ${op.toUpperCase()}`, result);
    }

    injectToolResult(op, result);
    callInFlight = false;
  }

  function sendToBackground(op, params) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "AGENT_CALL", op, params }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response?.result || { ok: false, error: "No response" });
      });
    });
  }

  function rejectAfter(ms) {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms / 1000}s`)), ms)
    );
  }

  function injectToolResult(op, result) {
    const resultText =
      `__TOOL_RESULT__\nop: ${op}\n` +
      JSON.stringify(result, null, 2) +
      `\n__END_RESULT__`;

    const input =
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector("textarea");

    if (!input) return;

    // Set content
    if (input.tagName === "TEXTAREA") {
      input.value = resultText;
    } else {
      // Use execCommand for contenteditable so React's synthetic events fire
      input.focus();
      document.execCommand("selectAll");
      document.execCommand("insertText", false, resultText);
    }

    // Dispatch React-compatible input event
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: resultText }));

    // Submit after a short tick
    setTimeout(() => {
      const sendBtn = document.querySelector(
        'button[aria-label="Send message"],' +
        'button[data-testid="send-button"]'
      );
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
      } else {
        input.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, bubbles: true
        }));
      }
    }, 150);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 6.  SCANNER  — reads ONLY sent messages, never the input box
  // ═══════════════════════════════════════════════════════════════════
  function scanForCalls() {
    if (callInFlight) return;

    // ── GUARD: if the input box currently contains __AGENT_CALL__,
    //    the user is still composing. Do NOT fire. ──────────────────
    const liveInput = getInputBoxText();
    if (liveInput.includes("__AGENT_CALL__")) return;

    const text = getSentMessagesText();
    CALL_PATTERN.lastIndex = 0;
    let m;

    while ((m = CALL_PATTERN.exec(text)) !== null) {
      const raw = m[1].trim();
      if (OLD_CHAT_SNAPSHOT.has(raw)) continue;
      if (processedCalls.has(raw))    continue;

      processedCalls.add(raw);
      handleAgentCall(raw);
      break; // one at a time
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 7.  TERMINAL PANEL
  // ═══════════════════════════════════════════════════════════════════
  let terminalPanel = null;
  let logContainer  = null;
  let isFullScreen  = false;
  let savedPos = { top:"20px", right:"20px", left:"auto", width:"420px", height:"550px" };

  function initializeTerminal() {
    if (document.getElementById("vbc-panel")) return;

    terminalPanel = document.createElement("div");
    terminalPanel.id = "vbc-panel";
    terminalPanel.style.cssText = `
      position:fixed; top:${savedPos.top}; right:${savedPos.right};
      width:${savedPos.width}; height:${savedPos.height};
      background:#1e1e2e; border:2px solid #313244; border-radius:12px;
      box-shadow:0 12px 32px rgba(0,0,0,.5);
      display:flex; flex-direction:column;
      font-family:'Consolas','Menlo','Monaco',monospace;
      z-index:999999; overflow:hidden; box-sizing:border-box;
    `;

    const header = document.createElement("div");
    header.id = "vbc-header";
    header.style.cssText = `
      padding:0 14px; height:42px; background:#11111b; color:#cdd6f4;
      font-size:12px; font-weight:bold;
      display:flex; justify-content:space-between; align-items:center;
      cursor:move; user-select:none;
      border-bottom:1px solid #313244; flex-shrink:0;
    `;
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="color:#f38ba8;">⬤</span>
        <span style="color:#f9e2af;">⬤</span>
        <span style="color:#a6e3a1;">⬤</span>
        <span style="margin-left:6px;color:#a6adc8;">VibesCode Console</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button id="vbc-export-btn" style="
          background:#313244;color:#cdd6f4;border:none;border-radius:4px;
          padding:4px 8px;font-size:11px;cursor:pointer;">💾 Export</button>
        <button id="vbc-fs-btn" style="
          background:#313244;color:#cdd6f4;border:none;border-radius:4px;
          padding:4px 10px;font-size:11px;cursor:pointer;font-weight:bold;">🗖 Maximize</button>
      </div>
    `;

    logContainer = document.createElement("div");
    logContainer.id = "vbc-logs";
    logContainer.style.cssText = `
      flex:1; min-height:0; padding:12px; background:#181825;
      overflow-y:auto; overflow-x:hidden;
      display:flex; flex-direction:column; gap:10px; box-sizing:border-box;
    `;

    terminalPanel.appendChild(header);
    terminalPanel.appendChild(logContainer);
    document.body.appendChild(terminalPanel);

    makeDraggable(terminalPanel, header);
    document.getElementById("vbc-fs-btn").addEventListener("click", toggleFullScreen);
    document.getElementById("vbc-export-btn").addEventListener("click", exportConversation);
  }

  // ─── Smooth drag via requestAnimationFrame ───────────────────────────────
  function makeDraggable(el, handle) {
    let dragging = false, startX, startY, startLeft, startTop, rafId;
    let pendingX = 0, pendingY = 0;

    handle.addEventListener("mousedown", (e) => {
      if (isFullScreen || e.target.closest("button")) return;
      dragging = true;
      startX   = e.clientX;
      startY   = e.clientY;
      const r  = el.getBoundingClientRect();
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
        let l = Math.max(0, Math.min(startLeft + pendingX - startX, window.innerWidth  - el.offsetWidth));
        let t = Math.max(0, Math.min(startTop  + pendingY - startY, window.innerHeight - el.offsetHeight));
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
        top:   terminalPanel.style.top,
        left:  terminalPanel.style.left,
        right: terminalPanel.style.right,
        width: terminalPanel.style.width,
        height:terminalPanel.style.height,
      };
      Object.assign(terminalPanel.style, {
        top:"0",left:"0",right:"0",width:"100vw",height:"100vh",borderRadius:"0"
      });
      btn.textContent = "🗗 Minimize";
      isFullScreen = true;
    } else {
      Object.assign(terminalPanel.style, { ...savedPos, borderRadius:"12px" });
      btn.textContent = "🗖 Maximize";
      isFullScreen = false;
    }
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  // ─── Log renderer ────────────────────────────────────────────────────────
  const TSTYLES = {
    request:{ bg:"#1e1e2e", border:"#89b4fa", hBg:"#89b4fa22", c:"#89b4fa" },
    success:{ bg:"#1b2b24", border:"#a6e3a1", hBg:"#a6e3a122", c:"#a6e3a1" },
    error:  { bg:"#2a1a1c", border:"#f38ba8", hBg:"#f38ba822", c:"#f38ba8" },
    info:   { bg:"#1e1e2e", border:"#cba6f7", hBg:"#cba6f722", c:"#cba6f7" },
  };

  function logToTerminal(type, title, data) {
    initializeTerminal();
    const s = TSTYLES[type] || TSTYLES.info;
    const el = document.createElement("div");
    el.style.cssText = `
      width:100%;border-radius:6px;background:${s.bg};
      border:1px solid ${s.border};font-size:11px;overflow:hidden;flex-shrink:0;
    `;
    el.innerHTML = `
      <div style="padding:6px 10px;background:${s.hBg};color:${s.c};
        font-weight:bold;display:flex;justify-content:space-between;">
        <span>${title}</span>
        <span style="color:#6c7086;">${new Date().toLocaleTimeString()}</span>
      </div>
      <pre style="padding:10px;margin:0;white-space:pre-wrap;word-break:break-all;
        color:#cdd6f4;background:#11111b55;">${esc(JSON.stringify(data,null,2))}</pre>
    `;
    logContainer.appendChild(el);
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  function esc(s) {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  // ─── Waiting banner ───────────────────────────────────────────────────────
  let bannerN = 0;

  function showWaitingBanner(op) {
    initializeTerminal();
    const id = `vbc-wait-${bannerN++}`;
    if (!document.getElementById("vbc-pulse")) {
      const s = document.createElement("style");
      s.id = "vbc-pulse";
      s.textContent = `@keyframes vbc-p{from{opacity:1}to{opacity:.35}}`;
      document.head.appendChild(s);
    }
    const b = document.createElement("div");
    b.id = id;
    b.style.cssText = `
      width:100%;padding:8px 12px;background:#2a2a3e;
      border:1px dashed #f9e2af;border-radius:6px;color:#f9e2af;
      font-size:11px;display:flex;align-items:center;gap:8px;flex-shrink:0;
      animation:vbc-p 1s infinite alternate;
    `;
    b.innerHTML = `<span style="font-size:16px;">⏳</span><span>Waiting for <strong>${op}</strong>…</span>`;
    logContainer.appendChild(b);
    logContainer.scrollTop = logContainer.scrollHeight;
    return id;
  }

  function removeWaitingBanner(id) {
    document.getElementById(id)?.remove();
  }

  function exportConversation() {
    const blob = new Blob([JSON.stringify(conversationStore,null,2)],{type:"application/json"});
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"),
      { href:url, download:`vibescode-${Date.now()}.json` });
    a.click();
    URL.revokeObjectURL(url);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 8.  BOOT
  // ═══════════════════════════════════════════════════════════════════
  initializeTerminal();
  attachInputWatcher();
  watchForAIResponse();

  // Delay first scan until snapshot is ready (matches the 50ms above)
  setTimeout(() => {
    scanForCalls();
    setInterval(scanForCalls, SCAN_INTERVAL);
  }, 100);

  // MutationObserver — only fires on changes to SENT message containers,
  // not on input box keystrokes
  const msgObserver = new MutationObserver(() => {
    if (!callInFlight) scanForCalls();
  });

  // Observe only the chat history container, not the whole body
  function attachMsgObserver() {
    const chatRoot =
      document.querySelector('[data-testid="conversation-turn-list"]') ||  // Claude
      document.querySelector("main") ||
      document.body;
    msgObserver.observe(chatRoot, { childList:true, subtree:true, characterData:true });
  }

  setTimeout(attachMsgObserver, 500);

})();