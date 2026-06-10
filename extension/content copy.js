// content.js  — VibesCode Agent  (v6)
// Fixes: reliable Gemini injection · conversation store skips tool turns
(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════
  // 0.  CONSTANTS
  // ═══════════════════════════════════════════════════════════════════
  const SCAN_INTERVAL   = 700;
  const TOOL_TIMEOUT_MS = 30_000;

  // Keyword finder — underscores optional (Gemini strips them)
  const KEYWORD_RE = /_*AGENT_CALL_*/g;

  // ═══════════════════════════════════════════════════════════════════
  // 1.  BRACE-BALANCED JSON EXTRACTOR
  //     Walks forward from keyword, finds first {, counts depth until
  //     balanced. Never grabs surrounding prose.
  // ═══════════════════════════════════════════════════════════════════
  function extractJSON(text, fromIndex) {
    let i = fromIndex;
    while (i < text.length && text[i] !== '{') i++;
    if (i >= text.length) return null;
    const start = i;
    let depth = 0;
    for (; i < text.length; i++) {
      if      (text[i] === '{') depth++;
      else if (text[i] === '}') { if (--depth === 0) return text.slice(start, i + 1); }
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

  // ═══════════════════════════════════════════════════════════════════
  // 2.  INPUT-BOX REGISTRY
  // ═══════════════════════════════════════════════════════════════════
  const inputElements = new WeakSet();
  function registerInputs() {
    document.querySelectorAll('div[contenteditable="true"],textarea')
      .forEach(el => inputElements.add(el));
  }
  setInterval(registerInputs, 1000);
  registerInputs();

  function getInputBox() {
    return document.querySelector('div[contenteditable="true"]') ||
           document.querySelector("textarea");
  }
  function getInputBoxText() {
    const el = getInputBox();
    return el ? (el.innerText || el.value || "").trim() : "";
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3.  SENT-MESSAGE TEXT (never reads the input box)
  // ═══════════════════════════════════════════════════════════════════
  const MSG_SELECTORS = [
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    '[data-message-author-role]',
    'user-query .query-text',
    'user-query',
    'model-response .response-content',
    'model-response',
    'message-content',
    '.human-turn',
    '.assistant-turn',
    '.chat-message',
  ];

  function getSentMessagesText() {
    let text = "";
    for (const sel of MSG_SELECTORS) {
      document.querySelectorAll(sel).forEach(el => {
        if (inputElements.has(el) || el.isContentEditable) return;
        text += (el.innerText || "") + "\n";
      });
    }
    return text;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 4.  OLD-CHAT SNAPSHOT (SPA-safe, waits for stable DOM)
  // ═══════════════════════════════════════════════════════════════════
  const OLD_CHAT_SNAPSHOT = new Set();
  let snapshotLocked   = false;
  let lastSnapshotHash = "";
  let snapshotAttempts = 0;

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

  function tryBuildSnapshot() {
    if (snapshotLocked) return;
    const calls = findAllCalls(getSentMessagesText());
    const hash  = calls.map(normaliseJSON).join("|");
    if (hash !== "" && hash === lastSnapshotHash) {
      calls.forEach(c => OLD_CHAT_SNAPSHOT.add(normaliseJSON(c)));
      snapshotLocked = true;
      console.log("[VibesCode v6] Snapshot locked. Old calls:", OLD_CHAT_SNAPSHOT.size);
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
        console.log("[VibesCode v6] Fresh page.");
      }
    }
  }, 400);

  // ═══════════════════════════════════════════════════════════════════
  // 5.  CONVERSATION STORE
  //     Skips storing any pair where the AI response contains a tool
  //     call or tool result — those are "agentic turns", not chat.
  // ═══════════════════════════════════════════════════════════════════
  const conversationStore = { pairs: [] };
  let   pendingHuman      = null;
  let   suppressNextStore = false;  // set true when a tool call is in flight

  function storePair(human, ai) {
    // Don't store tool-call turns in the conversation log
    if (suppressNextStore) { suppressNextStore = false; return; }
    if (ai.includes("AGENT_CALL") || ai.includes("__TOOL_RESULT__")) return;
    if (!human || !ai) return;

    conversationStore.pairs.push({ human, ai });
    window.__vibesConversation = conversationStore;
    logToTerminal("info", "💬 Conversation stored",
      conversationStore.pairs[conversationStore.pairs.length - 1]);
  }

  function attachInputWatcher() {
    const tryAttach = setInterval(() => {
      const input = getInputBox();
      if (!input) return;
      clearInterval(tryAttach);
      inputElements.add(input);

      // Capture human text on submit (before the box clears)
      const captureHuman = () => {
        const t = (input.innerText || input.value || "").trim();
        // Don't record tool-result injections as human messages
        if (t && !t.startsWith("__TOOL_RESULT__")) pendingHuman = t;
      };

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) captureHuman();
      }, true);

      document.addEventListener("click", (e) => {
        const btn = e.target.closest(
          'button[aria-label="Send message"],' +
          'button[data-testid="send-button"],' +
          'button[aria-label="Send"],' +
          'button[type="submit"]'
        );
        if (btn) captureHuman();
      }, true);
    }, 800);
  }

  function watchForAIResponse() {
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!pendingHuman) return;
        const ai = getLatestAIMessage();
        if (!ai) return;
        storePair(pendingHuman, ai);
        pendingHuman = null;
      }, 1500);
    }).observe(document.body, { childList:true, subtree:true, characterData:true });
  }

  function getLatestAIMessage() {
    const sels = [
      '[data-testid="assistant-message"] .whitespace-pre-wrap',
      '[data-message-author-role="assistant"] .markdown',
      'model-response .response-content',
      '.assistant-message',
    ];
    for (const s of sels) {
      const els = document.querySelectorAll(s);
      if (els.length) return els[els.length-1].innerText?.trim() || null;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 6.  BLOCKING TOOL-CALL HANDLER
  // ═══════════════════════════════════════════════════════════════════
  const processedCalls = new Set();
  let   callInFlight   = false;

  async function handleAgentCall(rawJSON) {
    if (callInFlight) return;
    callInFlight      = true;
    suppressNextStore = true;   // the next AI response is agentic, not chat

    const parsed = safeParseJSON(rawJSON);
    if (!parsed) {
      logToTerminal("error", "⚠️ Parse error",
        { raw: rawJSON, hint: "Could not extract valid JSON from brace block" });
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

    await injectToolResult(op, result);
    callInFlight = false;
  }

  function sendToBackground(op, params) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type:"AGENT_CALL", op, params }, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res?.result || { ok:false, error:"No response" });
      });
    });
  }

  function rejectAfter(ms) {
    return new Promise((_,r) =>
      setTimeout(() => r(new Error(`Timeout after ${ms/1000}s`)), ms));
  }

  // ═══════════════════════════════════════════════════════════════════
  // 7.  INJECT TOOL RESULT → GEMINI / ANY LLM
  //
  //     The ONLY reliable channel back to the AI is the chat input.
  //     We format the result clearly so the AI's system prompt tells
  //     it to read __TOOL_RESULT__ blocks and continue its work.
  //
  //     Injection strategy waterfall (most → least reliable):
  //       A. nativeInputValueSetter  — React textarea (ChatGPT)
  //       B. execCommand insertText  — contenteditable (Claude, Gemini)
  //       C. innerText + InputEvent  — last resort
  //
  //     After injection we wait for the send button to become enabled
  //     before clicking, with a 3s timeout fallback.
  // ═══════════════════════════════════════════════════════════════════
  function injectToolResult(op, result) {
    return new Promise((resolve) => {
      // Format the result block the AI will read
      const text =
        `__TOOL_RESULT__\nop: ${op}\n` +
        JSON.stringify(result, null, 2) +
        `\n__END_RESULT__\n\nContinue based on the result above.`;

      const input = getInputBox();
      if (!input) {
        logToTerminal("error", "⚠️ Inject failed", { reason: "No input box found" });
        return resolve();
      }

      input.focus();
      let injected = false;

      // ── Strategy A: React textarea ─────────────────────────────────
      if (input.tagName === "TEXTAREA") {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value"
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(input, text);
          injected = true;
        }
        if (!injected) { input.value = text; injected = true; }
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }

      // ── Strategy B: contenteditable (Claude, Gemini) ──────────────
      if (!injected || input.tagName !== "TEXTAREA") {
        // Clear existing content first
        const sel   = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.removeAllRanges();
        sel.addRange(range);

        injected = document.execCommand("insertText", false, text);

        // ── Strategy C: last resort ──────────────────────────────────
        if (!injected) {
          input.innerText = text;
          input.dispatchEvent(new InputEvent("input", {
            bubbles: true, data: text, inputType: "insertText"
          }));
          injected = true;
        }
      }

      // Wait for send button to become enabled, then click
      // Gemini enables the button asynchronously after state update
      waitForSendButton(input, 3000).then(() => resolve());
    });
  }

  function waitForSendButton(input, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();

      const SEND_SELECTOR =
        'button[aria-label="Send message"]:not([disabled]),' +
        'button[data-testid="send-button"]:not([disabled]),' +
        'button[aria-label="Send"]:not([disabled])';

      function attempt() {
        const btn = document.querySelector(SEND_SELECTOR);
        if (btn) {
          btn.click();
          logToTerminal("info", "📨 Result sent to AI", {});
          return resolve();
        }

        if (Date.now() - start > timeoutMs) {
          // Button never enabled — try keyboard fallback
          logToTerminal("info", "📨 Send via Enter (button timeout)", {});
          input.dispatchEvent(new KeyboardEvent("keydown", {
            key:"Enter", code:"Enter", keyCode:13, which:13,
            bubbles:true, cancelable:true
          }));
          return resolve();
        }

        setTimeout(attempt, 100);
      }

      setTimeout(attempt, 150); // first attempt after React tick
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 8.  SCANNER
  // ═══════════════════════════════════════════════════════════════════
  function scanForCalls() {
    if (!snapshotLocked) return;
    if (callInFlight)    return;
    if (getInputBoxText().includes("AGENT_CALL")) return;  // user composing

    const calls = findAllCalls(getSentMessagesText());
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
  // 9.  TERMINAL PANEL
  // ═══════════════════════════════════════════════════════════════════
  let terminalPanel = null;
  let logContainer  = null;
  let isFullScreen  = false;
  let savedPos = { top:"20px", right:"20px", left:"auto",
                   width:"420px", height:"550px" };

  function initializeTerminal() {
    if (document.getElementById("vbc-panel")) return;
    terminalPanel = document.createElement("div");
    terminalPanel.id = "vbc-panel";
    terminalPanel.style.cssText = `
      position:fixed;top:${savedPos.top};right:${savedPos.right};
      width:${savedPos.width};height:${savedPos.height};
      background:#1e1e2e;border:2px solid #313244;border-radius:12px;
      box-shadow:0 12px 32px rgba(0,0,0,.5);display:flex;flex-direction:column;
      font-family:'Consolas','Menlo','Monaco',monospace;
      z-index:999999;overflow:hidden;box-sizing:border-box;
    `;

    const header = document.createElement("div");
    header.id = "vbc-header";
    header.style.cssText = `
      padding:0 14px;height:42px;background:#11111b;color:#cdd6f4;font-size:12px;
      font-weight:bold;display:flex;justify-content:space-between;align-items:center;
      cursor:move;user-select:none;border-bottom:1px solid #313244;flex-shrink:0;
    `;
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="color:#f38ba8;">⬤</span><span style="color:#f9e2af;">⬤</span>
        <span style="color:#a6e3a1;">⬤</span>
        <span style="margin-left:6px;color:#a6adc8;">VibesCode Console</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button id="vbc-export-btn" style="background:#313244;color:#cdd6f4;border:none;
          border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;">💾 Export</button>
        <button id="vbc-fs-btn" style="background:#313244;color:#cdd6f4;border:none;
          border-radius:4px;padding:4px 10px;font-size:11px;cursor:pointer;font-weight:bold;">
          🗖 Maximize</button>
      </div>
    `;

    logContainer = document.createElement("div");
    logContainer.id = "vbc-logs";
    logContainer.style.cssText = `
      flex:1;min-height:0;padding:12px;background:#181825;overflow-y:auto;
      overflow-x:hidden;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;
    `;

    terminalPanel.appendChild(header);
    terminalPanel.appendChild(logContainer);
    document.body.appendChild(terminalPanel);

    makeDraggable(terminalPanel, header);
    document.getElementById("vbc-fs-btn").addEventListener("click", toggleFullScreen);
    document.getElementById("vbc-export-btn").addEventListener("click", exportConversation);
  }

  function makeDraggable(el, handle) {
    let dragging=false, startX, startY, startLeft, startTop, rafId;
    let pendingX=0, pendingY=0;
    handle.addEventListener("mousedown", (e) => {
      if (isFullScreen || e.target.closest("button")) return;
      dragging=true; startX=e.clientX; startY=e.clientY;
      const r=el.getBoundingClientRect();
      startLeft=r.left; startTop=r.top;
      el.style.right="auto"; el.style.left=startLeft+"px"; el.style.top=startTop+"px";
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

  function toggleFullScreen(e) {
    e.stopPropagation();
    const btn=document.getElementById("vbc-fs-btn");
    if (!isFullScreen) {
      savedPos={top:terminalPanel.style.top,left:terminalPanel.style.left,
        right:terminalPanel.style.right,width:terminalPanel.style.width,
        height:terminalPanel.style.height};
      Object.assign(terminalPanel.style,{top:"0",left:"0",right:"0",
        width:"100vw",height:"100vh",borderRadius:"0"});
      btn.textContent="🗗 Minimize"; isFullScreen=true;
    } else {
      Object.assign(terminalPanel.style,{...savedPos,borderRadius:"12px"});
      btn.textContent="🗖 Maximize"; isFullScreen=false;
    }
    logContainer.scrollTop=logContainer.scrollHeight;
  }

  const TSTYLES = {
    request:{bg:"#1e1e2e",border:"#89b4fa",hBg:"#89b4fa22",c:"#89b4fa"},
    success:{bg:"#1b2b24",border:"#a6e3a1",hBg:"#a6e3a122",c:"#a6e3a1"},
    error:  {bg:"#2a1a1c",border:"#f38ba8",hBg:"#f38ba822",c:"#f38ba8"},
    info:   {bg:"#1e1e2e",border:"#cba6f7",hBg:"#cba6f722",c:"#cba6f7"},
  };

  function logToTerminal(type, title, data) {
    initializeTerminal();
    const s=TSTYLES[type]||TSTYLES.info;
    const el=document.createElement("div");
    el.style.cssText=`width:100%;border-radius:6px;background:${s.bg};
      border:1px solid ${s.border};font-size:11px;overflow:hidden;flex-shrink:0;`;
    el.innerHTML=`
      <div style="padding:6px 10px;background:${s.hBg};color:${s.c};
        font-weight:bold;display:flex;justify-content:space-between;">
        <span>${title}</span>
        <span style="color:#6c7086;">${new Date().toLocaleTimeString()}</span>
      </div>
      <pre style="padding:10px;margin:0;white-space:pre-wrap;word-break:break-all;
        color:#cdd6f4;background:#11111b55;">${esc(JSON.stringify(data,null,2))}</pre>
    `;
    logContainer.appendChild(el);
    logContainer.scrollTop=logContainer.scrollHeight;
  }

  function esc(s){
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  let bannerN=0;
  function showWaitingBanner(op) {
    initializeTerminal();
    const id=`vbc-wait-${bannerN++}`;
    if (!document.getElementById("vbc-pulse")) {
      const s=document.createElement("style");
      s.id="vbc-pulse";
      s.textContent=`@keyframes vbc-p{from{opacity:1}to{opacity:.35}}`;
      document.head.appendChild(s);
    }
    const b=document.createElement("div");
    b.id=id;
    b.style.cssText=`width:100%;padding:8px 12px;background:#2a2a3e;
      border:1px dashed #f9e2af;border-radius:6px;color:#f9e2af;font-size:11px;
      display:flex;align-items:center;gap:8px;flex-shrink:0;
      animation:vbc-p 1s infinite alternate;`;
    b.innerHTML=`<span style="font-size:16px;">⏳</span>
      <span>Waiting for <strong>${op}</strong>…</span>`;
    logContainer.appendChild(b);
    logContainer.scrollTop=logContainer.scrollHeight;
    return id;
  }

  function removeWaitingBanner(id){ document.getElementById(id)?.remove(); }

  function exportConversation() {
    const blob=new Blob([JSON.stringify(conversationStore,null,2)],
      {type:"application/json"});
    const url=URL.createObjectURL(blob);
    Object.assign(document.createElement("a"),
      {href:url,download:`vibescode-${Date.now()}.json`}).click();
    URL.revokeObjectURL(url);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 10. BOOT
  // ═══════════════════════════════════════════════════════════════════
  initializeTerminal();
  attachInputWatcher();
  watchForAIResponse();
  setInterval(scanForCalls, SCAN_INTERVAL);

  function attachMsgObserver() {
    const root =
      document.querySelector('[data-testid="conversation-turn-list"]') ||
      document.querySelector("chat-history") ||
      document.querySelector("main") ||
      document.body;
    new MutationObserver(() => {
      if (!callInFlight) scanForCalls();
    }).observe(root, { childList:true, subtree:true, characterData:true });
  }
  setTimeout(attachMsgObserver, 600);

  console.log("[VibesCode v6] Loaded.");
})();
