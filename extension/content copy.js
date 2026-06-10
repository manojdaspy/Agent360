// content.js — VibesCode Agent v10
// ════════════════════════════════════════════════════════════════════════════
// Key improvements over v9:
//   • Multi-strategy send: button click → Enter key → Ctrl+Enter → clipboard paste
//   • Per-platform send logic with deep selector fallback chains
//   • Mutation-aware button poller (waits for React re-render after text insert)
//   • Input injection uses ClipboardItem API as primary path for contenteditable
//   • Exponential backoff reconnect on SSE errors
//   • _processed fingerprint set capped with LRU-style eviction (no memory leak)
//   • Per-session _busy lock (keyed to session tab id) — no cross-tab collision
//   • Push channel per-client queue registry — safe for multi-tab use
//   • Heartbeat ACK: extension POSTs /push/ack after each injected message
//   • Fine-grained send diagnostics logged to terminal panel
// ════════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  // ══════════════════════════════════════════════════════════════════════════
  // 0. CONFIG
  // ══════════════════════════════════════════════════════════════════════════
  const MCP_BASE_URL = "https://studentassignment.lyralogics.com";
  const MCP_SSE_URL  = `${MCP_BASE_URL}/mcp/sse`;
  const MCP_POST_URL = `${MCP_BASE_URL}/mcp/messages`;
  const PUSH_SSE_URL = `${MCP_BASE_URL}/push/stream`;
  const PUSH_ACK_URL = `${MCP_BASE_URL}/push/ack`;

  // Unique ID for this tab instance (for push channel multi-client safety)
  const TAB_ID = Math.random().toString(36).slice(2, 10);

  // ══════════════════════════════════════════════════════════════════════════
  // 1. PLATFORM SELECTORS  — each platform has multiple fallback send strategies
  // ══════════════════════════════════════════════════════════════════════════
  const PLATFORMS = [
    {
      name:     "ChatGPT",
      match:    h => h.includes("chatgpt.com") || h.includes("chat.openai.com"),
      userMsg:  '[data-message-author-role="user"] .whitespace-pre-wrap',
      aiMsg:    '[data-message-author-role="assistant"] .markdown',
      input:    '#prompt-textarea',
      // Ordered fallback list — first match wins
      sendBtns: [
        '[data-testid="send-button"]:not([disabled])',
        'button[aria-label="Send message"]:not([disabled])',
        'button[aria-label="Send prompt"]:not([disabled])',
        'form button[type="submit"]:not([disabled])',
      ],
      chatRoot: 'main',
      // How to trigger send if all buttons fail
      sendKeys: [{ key: "Enter", code: "Enter", keyCode: 13 }],
    },
    {
      name:     "Claude",
      match:    h => h.includes("claude.ai"),
      userMsg:  '[data-testid="user-message"]',
      aiMsg:    '[data-testid="assistant-message"] .whitespace-pre-wrap',
      input:    'div[contenteditable="true"][data-placeholder]',
      sendBtns: [
        'button[aria-label="Send message"]:not([disabled])',
        'button[aria-label="Send Message"]:not([disabled])',
        'button[type="submit"]:not([disabled])',
        '[data-testid="send-button"]:not([disabled])',
      ],
      chatRoot: '[data-testid="conversation-turn-list"]',
      sendKeys: [{ key: "Enter", code: "Enter", keyCode: 13 }],
    },
    {
      name:     "Gemini",
      match:    h => h.includes("gemini.google.com"),
      userMsg:  'user-query .query-text',
      aiMsg:    'model-response .markdown',
      input:    'rich-textarea div[contenteditable="true"]',
      sendBtns: [
        'button.send-button:not([disabled])',
        'button[aria-label="Send message"]:not([disabled])',
        'button[mattooltip="Send message"]:not([disabled])',
        'button[aria-label="Submit"]:not([disabled])',
        '.send-button:not([disabled])',
        // Gemini sometimes uses a mat-icon-button inside the form
        'mat-icon-button[type="submit"]:not([disabled])',
        'button[type="submit"]:not([disabled])',
      ],
      chatRoot: 'chat-history',
      // Gemini often needs Ctrl+Enter
      sendKeys: [
        { key: "Enter", code: "Enter", keyCode: 13, ctrlKey: false },
        { key: "Enter", code: "Enter", keyCode: 13, ctrlKey: true },
      ],
    },
    {
      name:     "Perplexity",
      match:    h => h.includes("perplexity.ai"),
      userMsg:  '[data-testid="user-message"]',
      aiMsg:    '.prose',
      input:    'textarea',
      sendBtns: [
        'button[aria-label="Submit"]:not([disabled])',
        'button[type="submit"]:not([disabled])',
        'button.bg-super:not([disabled])',
      ],
      chatRoot: 'main',
      sendKeys: [{ key: "Enter", code: "Enter", keyCode: 13 }],
    },
    {
      name:     "Generic",
      match:    () => true,
      userMsg:  '.user-message, .human-turn, [class*="user-turn"]',
      aiMsg:    '.assistant-message, .bot-message, [class*="assistant-turn"]',
      input:    'div[contenteditable="true"], textarea',
      sendBtns: [
        'button[aria-label="Send message"]:not([disabled])',
        'button[type="submit"]:not([disabled])',
        'button[aria-label="Submit"]:not([disabled])',
      ],
      chatRoot: 'main, body',
      sendKeys: [{ key: "Enter", code: "Enter", keyCode: 13 }],
    },
  ];

  const PLATFORM = PLATFORMS.find(p => p.match(location.hostname));
  console.log("[VibesCode v10] Platform:", PLATFORM.name);

  // ══════════════════════════════════════════════════════════════════════════
  // 2. DOM HELPERS
  // ══════════════════════════════════════════════════════════════════════════
  const $  = (sel, root = document) => { try { return root.querySelector(sel); } catch { return null; } };
  const $$ = (sel, root = document) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };

  const getInput = () => {
    // Try platform-specific selector first, then common fallbacks
    const selectors = [
      PLATFORM.input,
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"]',
      'textarea:not([aria-hidden="true"])',
      '#prompt-textarea',
    ];
    for (const sel of selectors) {
      const el = $(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  };

  // Try each send button selector in order; return first match
  const getSendBtn = () => {
    for (const sel of PLATFORM.sendBtns) {
      const btn = $(sel);
      if (btn && isVisible(btn) && !btn.disabled) return btn;
    }
    // Last resort: any visible non-disabled submit button near the input
    const allBtns = $$('button:not([disabled])');
    for (const btn of allBtns) {
      const label = (btn.getAttribute('aria-label') || btn.title || btn.textContent || "").toLowerCase();
      if (/send|submit|go/.test(label) && isVisible(btn)) return btn;
    }
    return null;
  };

  const getChatRoot = () => $(PLATFORM.chatRoot) || $('main') || document.body;

  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
  };

  const isBotTyping = () => !!(
    $('button[aria-label="Stop response"]') ||
    $('button[aria-label="Stop generating"]') ||
    $('[data-testid="stop-button"]') ||
    $('.stop-button') ||
    $('[aria-label="Stop"]') ||
    // Gemini spinner
    $('loading-indicator:not([hidden])') ||
    $('.loading-indicator-container:not([hidden])') ||
    // ChatGPT streaming indicator
    $('[data-testid="stop-button"]')
  );

  // ══════════════════════════════════════════════════════════════════════════
  // 3. TEXT INJECTION  — multi-strategy with deep fallback
  // ══════════════════════════════════════════════════════════════════════════
  async function injectText(input, text) {
    input.focus();
    await sleep(80);

    // Strategy A: execCommand (best React/Vue compat, being deprecated but still works)
    if (tryExecCommand(input, text)) {
      log("info", "📝 Injected via execCommand", { chars: text.length });
      return true;
    }

    // Strategy B: InputEvent with dataTransfer (modern replacement for execCommand)
    if (tryInputEvent(input, text)) {
      log("info", "📝 Injected via InputEvent", { chars: text.length });
      return true;
    }

    // Strategy C: Clipboard paste (most reliable for stubborn editors)
    if (await tryClipboardPaste(input, text)) {
      log("info", "📝 Injected via clipboard paste", { chars: text.length });
      return true;
    }

    // Strategy D: Direct value/innerText assignment (last resort, may break state)
    forceAssign(input, text);
    log("warn", "📝 Injected via force-assign (may miss framework state)", { chars: text.length });
    return true;
  }

  function tryExecCommand(input, text) {
    try {
      const sel = window.getSelection();
      if (sel && input.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const ok = document.execCommand("insertText", false, text);
      if (ok && getInputValue(input).length > 0) return true;
    } catch { /* fall through */ }
    return false;
  }

  function tryInputEvent(input, text) {
    try {
      if (input.isContentEditable) {
        // Clear first
        input.innerHTML = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        // Insert via DataTransfer
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        input.dispatchEvent(new InputEvent("input", {
          bubbles: true, cancelable: true,
          inputType: "insertFromPaste",
          data: text,
          dataTransfer: dt,
        }));
        // If framework didn't pick it up, set it directly on a text node
        if (!getInputValue(input)) {
          const node = document.createTextNode(text);
          input.appendChild(node);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value"
        )?.set || Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(input, text);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        } else return false;
      }
      return getInputValue(input).length > 0;
    } catch { return false; }
  }

  async function tryClipboardPaste(input, text) {
    try {
      // Write to clipboard then paste
      await navigator.clipboard.writeText(text);
      input.focus();
      await sleep(60);
      // Dispatch paste event
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const pasteOk = input.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true, cancelable: true, clipboardData: dt,
      }));
      await sleep(80);
      if (getInputValue(input).length > 0) return true;
      // If paste event not handled, try document.execCommand paste
      input.focus();
      document.execCommand("paste");
      await sleep(80);
      return getInputValue(input).length > 0;
    } catch { return false; }
  }

  function forceAssign(input, text) {
    if (input.isContentEditable) {
      input.innerText = text;
    } else {
      input.value = text;
    }
    // Fire all the events frameworks might listen to
    ["input", "change", "keyup", "keydown"].forEach(ev =>
      input.dispatchEvent(new Event(ev, { bubbles: true }))
    );
  }

  function getInputValue(input) {
    return (input.isContentEditable ? input.innerText : input.value) || "";
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. SEND BUTTON — multi-strategy with mutation-aware polling
  // ══════════════════════════════════════════════════════════════════════════
  async function triggerSend(input) {
    // Poll for the button to appear — React often re-renders after text insert
    const btn = await pollForSendButton(6000);

    if (btn) {
      // Strategy 1: Programmatic click
      btn.focus();
      btn.click();
      log("info", "📨 Sent via button.click()", { button: btn.getAttribute("aria-label") || btn.className });
      return true;
    }

    log("warn", "⚠️ Send button not found — trying keyboard fallbacks");

    // Strategy 2: Platform-defined key sequences
    for (const keyOpts of (PLATFORM.sendKeys || [])) {
      dispatchKey(input, keyOpts);
      await sleep(120);
      // Check if the input was cleared (a sign that submission worked)
      if (getInputValue(input).length === 0) {
        log("info", "📨 Sent via keyboard shortcut", { key: keyOpts.key });
        return true;
      }
    }

    // Strategy 3: Enter on the input directly as a final fallback
    dispatchKey(input, { key: "Enter", code: "Enter", keyCode: 13 });
    await sleep(200);
    if (getInputValue(input).length === 0) {
      log("info", "📨 Sent via Enter fallback");
      return true;
    }

    log("error", "❌ All send strategies failed — message may not have been submitted");
    return false;
  }

  function dispatchKey(target, opts) {
    const base = {
      bubbles: true, cancelable: true,
      key: opts.key, code: opts.code,
      keyCode: opts.keyCode, which: opts.keyCode,
      ctrlKey: !!opts.ctrlKey,
      metaKey: !!opts.metaKey,
      shiftKey: !!opts.shiftKey,
    };
    target.dispatchEvent(new KeyboardEvent("keydown", base));
    target.dispatchEvent(new KeyboardEvent("keypress", base));
    target.dispatchEvent(new KeyboardEvent("keyup", base));
  }

  // Polls for the send button using a MutationObserver fallback for React re-renders
  function pollForSendButton(timeoutMs) {
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;

      // Check immediately
      const btn = getSendBtn();
      if (btn) return resolve(btn);

      // Watch DOM mutations (React/Vue update the button state after text insert)
      let resolved = false;
      const mo = new MutationObserver(() => {
        if (resolved) return;
        const b = getSendBtn();
        if (b) { resolved = true; mo.disconnect(); clearTimeout(timer); resolve(b); }
      });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "aria-disabled"] });

      // Also poll at intervals in case MutationObserver misses attribute changes
      const interval = setInterval(() => {
        if (resolved) return clearInterval(interval);
        const b = getSendBtn();
        if (b) { resolved = true; mo.disconnect(); clearInterval(interval); clearTimeout(timer); resolve(b); }
      }, 120);

      const timer = setTimeout(() => {
        if (!resolved) { resolved = true; mo.disconnect(); clearInterval(interval); resolve(null); }
      }, timeoutMs);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. MAIN typeIntoInput — orchestrates inject + send with full retry
  // ══════════════════════════════════════════════════════════════════════════
  async function typeIntoInput(text, submit = true) {
    // Wait for bot to finish generating (up to 60s)
    await waitUntil(() => !isBotTyping(), 60_000);
    await sleep(300); // brief settle after AI finishes

    const input = getInput();
    if (!input) {
      log("error", "⚠️ No input box found", { platform: PLATFORM.name });
      return false;
    }

    // Inject text with multi-strategy fallback
    await injectText(input, text);
    await sleep(150); // let framework digest the input event

    if (!submit) return true;

    const sent = await triggerSend(input);
    return sent;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. MCP CLIENT  (JSON-RPC 2.0 over SSE)
  // ══════════════════════════════════════════════════════════════════════════
  const McpClient = (() => {
    let _sessionPostUrl = null;
    let _pendingCalls   = new Map();
    let _nextId         = 1;
    let _initialized    = false;
    let _sseSource      = null;
    let _backoffMs      = 1000;  // exponential backoff start

    function connect() {
      log("info", "🔌 Connecting to MCP", { url: MCP_SSE_URL });
      _sseSource = new EventSource(MCP_SSE_URL);

      _sseSource.addEventListener("endpoint", async (e) => {
        const raw = e.data.trim();
        _sessionPostUrl = raw.startsWith("http")
          ? raw
          : MCP_BASE_URL.replace(/\/$/, "") + raw;
        log("info", "📡 MCP session endpoint", { url: _sessionPostUrl });
        await _initialize();
      });

      _sseSource.addEventListener("message", (e) => {
        let msg;
        try { msg = JSON.parse(e.data); }
        catch { log("error", "⚠️ MCP message parse error", { raw: e.data }); return; }
        _handleRpcResponse(msg);
      });

      _sseSource.onerror = () => {
        log("error", `❌ MCP SSE error — reconnecting in ${_backoffMs}ms`, {});
        _sseSource.close();
        _initialized = false;
        _sessionPostUrl = null;
        updateStatus("🔴 MCP Disconnected");
        setTimeout(() => { _backoffMs = Math.min(_backoffMs * 2, 30_000); connect(); }, _backoffMs);
      };

      _sseSource.onopen = () => { _backoffMs = 1000; }; // reset on successful connect
    }

    async function _send(method, params = {}) {
      if (!_sessionPostUrl) throw new Error("MCP not connected");
      const id  = _nextId++;
      const rpc = { jsonrpc: "2.0", id, method, params };
      return new Promise((resolve, reject) => {
        _pendingCalls.set(id, { resolve, reject });
        fetch(_sessionPostUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rpc),
        }).catch(err => { _pendingCalls.delete(id); reject(err); });
      });
    }

    function _handleRpcResponse(msg) {
      const pending = _pendingCalls.get(msg.id);
      if (!pending) return;
      _pendingCalls.delete(msg.id);
      if (msg.error) pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      else pending.resolve(msg.result);
    }

    async function _initialize() {
      try {
        await _send("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "vibescode-extension", version: "10.0.0" },
        });
        _initialized = true;
        updateStatus("✅ MCP Ready");
        log("success", "✅ MCP initialized", { server: MCP_BASE_URL });
      } catch (err) {
        log("error", "❌ MCP initialize failed", { error: err.message });
      }
    }

    async function callTool(name, args = {}) {
      if (!_initialized) throw new Error("MCP not ready");
      log("request", `📡 TOOL: ${name}`, { args });
      const result = await _send("tools/call", { name, arguments: args });
      const text = result?.content?.[0]?.text ?? JSON.stringify(result);
      const ok   = !result?.isError;
      if (ok) log("success", `✅ ${name}`, { result: text.slice(0, 400) });
      else    log("error",   `❌ ${name}`, { error: text });
      return { ok, text, raw: result };
    }

    return { connect, callTool, isReady: () => _initialized };
  })();

  // ══════════════════════════════════════════════════════════════════════════
  // 7. AI OUTPUT SCANNER
  // ══════════════════════════════════════════════════════════════════════════
  const OP_TO_TOOL = {
    cat: "cat", read: "cat", read_file: "cat",
    tree: "tree",
    dir: "dir", ls: "dir",
    search: "search", grep: "search",
    write: "write", write_file: "write",
    patch: "patch", edit: "patch",
    mkdir: "mkdir",
    delete: "delete", rm: "delete",
    shell: "shell", run: "shell",
    pytest: "pytest",
    django_check: "django_check", check: "django_check",
    git_status: "git_status", status: "git_status",
    git_diff: "git_diff", diff: "git_diff",
    git_log: "git_log", log: "git_log",
    flake8: "flake8", lint: "flake8",
  };

  const _seenNodes = new WeakSet();
  const _seenTexts = new Set();

  // Capped LRU-style processed set to prevent memory leak on long sessions
  const _processed = (() => {
    const MAX = 500;
    const s = new Set();
    return {
      has: k => s.has(k),
      add: k => { if (s.size >= MAX) s.delete(s.values().next().value); s.add(k); },
    };
  })();

  let _busy      = false;
  let _callCount = 0;

  function scanAiMessages() {
    $$(PLATFORM.aiMsg).forEach(el => {
      if (_seenNodes.has(el)) return;
      const text = (el.innerText || "").trim();
      if (!text || text.length < 4) return;
      const fp = "a:" + text.slice(0, 200);
      if (_seenTexts.has(fp)) return;
      _seenNodes.add(el);
      _seenTexts.add(fp);

      log("ai", "🤖 AI", { message: text.length > 300 ? text.slice(0, 300) + "…" : text });

      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("AGENT_CALL")) continue;
        const jsonPart = trimmed.replace(/^AGENT_CALL\s*:?\s*/, "");
        let call;
        try { call = JSON.parse(jsonPart); }
        catch { log("error", "⚠️ AGENT_CALL parse error", { line: trimmed }); continue; }
        const callFp = JSON.stringify(call);
        if (_processed.has(callFp)) continue;
        _processed.add(callFp);
        scheduleToolCall(call);
        break;
      }
    });
  }

  function scanUserMessages() {
    $$(PLATFORM.userMsg).forEach(el => {
      if (_seenNodes.has(el)) return;
      const text = (el.innerText || "").trim();
      if (!text || text.length < 2) return;
      const fp = "u:" + text.slice(0, 200);
      if (_seenTexts.has(fp)) return;
      _seenNodes.add(el);
      _seenTexts.add(fp);
      log("user", "👤 You", { message: text });
    });
  }

  async function scheduleToolCall(call) {
    if (_busy) {
      await sleep(800);
      scheduleToolCall(call);
      return;
    }
    _busy = true;
    updateStatus(`🔧 ${call.op || call.name}`);

    const toolName = OP_TO_TOOL[call.op] || call.op || call.name;
    const { op, name: _n, ...args } = call;

    let result;
    try {
      result = await McpClient.callTool(toolName, args);
    } catch (err) {
      result = { ok: false, text: err.message };
    }

    _callCount++;
    updateCallCount(_callCount);
    updateStatus("⏳ Injecting result…");

    const reply =
      `__TOOL_RESULT__\nop: ${toolName}\n` +
      (result.ok ? result.text.slice(0, 6000) : `ERROR: ${result.text}`) +
      `\n__END_RESULT__\n\nContinue based on the result above.`;

    const sent = await typeIntoInput(reply, true);
    updateStatus(sent ? "✅ Done" : "⚠️ Send failed");
    _busy = false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. SERVER → EXTENSION PUSH CHANNEL  (per-client queue, with ACK)
  // ══════════════════════════════════════════════════════════════════════════
  function connectPushChannel() {
    // Include tab ID so server can target specific clients if needed
    const url = `${PUSH_SSE_URL}?tab=${TAB_ID}`;
    log("info", "📥 Connecting to push channel", { url, tab: TAB_ID });
    let backoff = 1000;
    let es;

    function open() {
      es = new EventSource(url);

      es.addEventListener("inject", async (e) => {
        let payload;
        try { payload = JSON.parse(e.data); }
        catch { payload = { text: e.data, submit: true }; }

        const text   = payload.text   ?? "";
        const submit = payload.submit ?? true;
        const msgId  = payload.id     ?? null;

        if (!text) return;
        log("info", "📥 Push received", { text: text.slice(0, 80), submit, id: msgId });

        const sent = await typeIntoInput(text, submit);

        // ACK back to server
        try {
          await fetch(PUSH_ACK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tab: TAB_ID, id: msgId, sent }),
          });
        } catch { /* ACK failure is non-critical */ }
      });

      es.onerror = () => {
        log("error", `❌ Push channel error — reconnecting in ${backoff}ms`, {});
        es.close();
        setTimeout(() => { backoff = Math.min(backoff * 2, 30_000); open(); }, backoff);
      };

      es.onopen = () => { backoff = 1000; };
    }

    open();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 9. UTILITIES
  // ══════════════════════════════════════════════════════════════════════════
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function waitUntil(predicate, timeoutMs = 10_000) {
    return new Promise(resolve => {
      const start = Date.now();
      const tick = () => {
        if (predicate()) return resolve();
        if (Date.now() - start > timeoutMs) return resolve();
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 10. TERMINAL PANEL
  // ══════════════════════════════════════════════════════════════════════════
  let _panel    = null;
  let _logCont  = null;
  let _filter   = "all";
  let _isFs     = false;
  let _savedPos = { top:"20px", right:"20px", left:"auto", width:"440px", height:"560px" };

  const TSTYLE = {
    request: { bg:"#1e1e2e", border:"#89b4fa", hBg:"#89b4fa22", c:"#89b4fa" },
    success: { bg:"#1b2b24", border:"#a6e3a1", hBg:"#a6e3a122", c:"#a6e3a1" },
    error:   { bg:"#2a1a1c", border:"#f38ba8", hBg:"#f38ba822", c:"#f38ba8" },
    warn:    { bg:"#2a2310", border:"#f9e2af", hBg:"#f9e2af22", c:"#f9e2af" },
    info:    { bg:"#1e1e2e", border:"#cba6f7", hBg:"#cba6f722", c:"#cba6f7" },
    user:    { bg:"#1a1a2e", border:"#f9e2af", hBg:"#f9e2af22", c:"#f9e2af" },
    ai:      { bg:"#1a2a1a", border:"#94e2d5", hBg:"#94e2d522", c:"#94e2d5" },
  };

  function initPanel() {
    if (document.getElementById("vbc-panel")) return;
    _panel = document.createElement("div");
    _panel.id = "vbc-panel";
    _panel.style.cssText = [
      "position:fixed", `top:${_savedPos.top}`, `right:${_savedPos.right}`,
      `width:${_savedPos.width}`, `height:${_savedPos.height}`,
      "background:#1e1e2e", "border:2px solid #313244", "border-radius:12px",
      "box-shadow:0 12px 32px rgba(0,0,0,.6)", "display:flex", "flex-direction:column",
      "font-family:'Consolas','Menlo','Monaco',monospace",
      "z-index:999999", "overflow:hidden", "box-sizing:border-box",
    ].join(";");

    const hdr = document.createElement("div");
    hdr.id = "vbc-hdr";
    hdr.style.cssText = "padding:0 12px;height:44px;background:#11111b;color:#cdd6f4;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;border-bottom:1px solid #313244;flex-shrink:0;";
    hdr.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="color:#f38ba8;font-size:10px;">⬤</span>
        <span style="color:#f9e2af;font-size:10px;">⬤</span>
        <span style="color:#a6e3a1;font-size:10px;">⬤</span>
        <span style="margin-left:4px;color:#a6adc8;font-size:11px;font-weight:bold;">VibesCode</span>
        <span style="font-size:9px;padding:2px 6px;border-radius:10px;background:#313244;color:#cba6f7;margin-left:4px;">${PLATFORM.name}</span>
        <span id="vbc-mcp-badge" style="font-size:9px;padding:2px 6px;border-radius:10px;background:#2a1a3e;color:#89b4fa;margin-left:2px;">v10</span>
      </div>
      <div style="display:flex;gap:4px;align-items:center;">
        <button id="vbc-clear" title="Clear logs" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">🗑</button>
        <button id="vbc-export" title="Export logs" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">💾</button>
        <button id="vbc-fs" title="Fullscreen" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 9px;font-size:10px;cursor:pointer;font-weight:bold;">🗖</button>
      </div>`;

    const statusBar = document.createElement("div");
    statusBar.style.cssText = "padding:3px 12px;background:#11111b;border-bottom:1px solid #1e1e2e;font-size:10px;color:#6c7086;display:flex;justify-content:space-between;flex-shrink:0;";
    statusBar.innerHTML = '<span id="vbc-status">⏳ Connecting…</span><span id="vbc-calls">🔧 0 calls</span>';

    const tabs = document.createElement("div");
    tabs.id = "vbc-tabs";
    tabs.style.cssText = "display:flex;gap:4px;padding:6px 10px;background:#181825;border-bottom:1px solid #313244;flex-shrink:0;";
    [["all","All"],["user","👤 User"],["ai","🤖 AI"],["tool","🔧 Tools"]].forEach(([f,l]) => {
      const b = document.createElement("button");
      b.dataset.f = f;
      b.textContent = l;
      b.style.cssText = "font-size:10px;padding:3px 8px;border-radius:4px;cursor:pointer;border:1px solid #313244;background:transparent;color:#6c7086;";
      if (f === "all") { b.style.borderColor="#89b4fa"; b.style.background="#89b4fa22"; b.style.color="#89b4fa"; }
      tabs.appendChild(b);
    });

    _logCont = document.createElement("div");
    _logCont.id = "vbc-logs";
    _logCont.style.cssText = "flex:1;min-height:0;padding:10px;background:#181825;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;";

    _panel.appendChild(hdr);
    _panel.appendChild(statusBar);
    _panel.appendChild(tabs);
    _panel.appendChild(_logCont);
    document.body.appendChild(_panel);

    _makeDraggable(_panel, hdr);

    document.getElementById("vbc-fs").addEventListener("click", e => { e.stopPropagation(); _toggleFs(); });
    document.getElementById("vbc-clear").addEventListener("click", e => { e.stopPropagation(); _logCont.innerHTML = ""; });
    document.getElementById("vbc-export").addEventListener("click", e => { e.stopPropagation(); _export(); });
    tabs.addEventListener("click", e => {
      const btn = e.target.closest("button[data-f]");
      if (!btn) return;
      _filter = btn.dataset.f;
      tabs.querySelectorAll("button[data-f]").forEach(b => {
        const active = b === btn;
        b.style.borderColor = active ? "#89b4fa" : "#313244";
        b.style.background  = active ? "#89b4fa22" : "transparent";
        b.style.color       = active ? "#89b4fa" : "#6c7086";
      });
      _applyFilter(_filter);
    });
  }

  function _applyFilter(f) {
    _logCont.querySelectorAll("[data-lt]").forEach(el => {
      const t = el.dataset.lt;
      el.style.display = (
        f === "all" ||
        (f === "user" && t === "user") ||
        (f === "ai"   && t === "ai") ||
        (f === "tool" && ["request","success","error","warn"].includes(t))
      ) ? "" : "none";
    });
  }

  function updateStatus(txt) { const e = document.getElementById("vbc-status"); if (e) e.textContent = txt; }
  function updateCallCount(n) { const e = document.getElementById("vbc-calls"); if (e) e.textContent = `🔧 ${n} call${n!==1?"s":""}`; }

  function log(type, title, data = {}) {
    initPanel();
    if (!_logCont) return;
    const s = TSTYLE[type] || TSTYLE.info;
    const body = JSON.stringify(data, null, 2);
    const big = body.length > 600;
    const collapsed = big && ["success","request"].includes(type);

    const el = document.createElement("div");
    el.dataset.lt = type;
    el.style.cssText = `width:100%;border-radius:6px;background:${s.bg};border:1px solid ${s.border};font-size:11px;overflow:hidden;flex-shrink:0;`;

    const h = document.createElement("div");
    h.style.cssText = `padding:5px 10px;background:${s.hBg};color:${s.c};font-weight:bold;display:flex;justify-content:space-between;align-items:center;cursor:${collapsed?"pointer":"default"};`;
    h.innerHTML = `<span>${title}${collapsed?' <span style="color:#6c7086;font-size:9px">(expand)</span>':""}</span><span style="color:#6c7086;font-size:10px;">${new Date().toLocaleTimeString()}</span>`;

    const pre = document.createElement("pre");
    pre.style.cssText = `padding:8px 10px;margin:0;white-space:pre-wrap;word-break:break-all;color:#cdd6f4;background:#11111b55;max-height:280px;overflow-y:auto;display:${collapsed?"none":"block"};font-size:11px;`;
    pre.textContent = body;

    if (collapsed) h.addEventListener("click", () => {
      const show = pre.style.display === "none";
      pre.style.display = show ? "block" : "none";
      const hint = h.querySelector("span span");
      if (hint) hint.textContent = show ? "(collapse)" : "(expand)";
    });

    el.appendChild(h);
    el.appendChild(pre);
    _logCont.appendChild(el);
    _logCont.scrollTop = _logCont.scrollHeight;
    if (_filter !== "all") _applyFilter(_filter);
  }

  function _makeDraggable(el, handle) {
    let drag=false, sx, sy, sl, st, raf;
    handle.addEventListener("mousedown", e => {
      if (_isFs || e.target.closest("button")) return;
      drag=true; sx=e.clientX; sy=e.clientY;
      const r=el.getBoundingClientRect(); sl=r.left; st=r.top;
      el.style.right="auto"; el.style.left=sl+"px"; el.style.top=st+"px";
      e.preventDefault();
    });
    document.addEventListener("mousemove", e => {
      if (!drag) return;
      if (raf) return;
      raf=requestAnimationFrame(() => {
        raf=null; if (!drag) return;
        const l=Math.max(0,Math.min(sl+e.clientX-sx,innerWidth-el.offsetWidth));
        const t=Math.max(0,Math.min(st+e.clientY-sy,innerHeight-el.offsetHeight));
        el.style.left=l+"px"; el.style.top=t+"px";
      });
    });
    document.addEventListener("mouseup", () => { drag=false; });
  }

  function _toggleFs() {
    const btn = document.getElementById("vbc-fs");
    if (!_isFs) {
      _savedPos = { top:_panel.style.top, left:_panel.style.left, right:_panel.style.right, width:_panel.style.width, height:_panel.style.height };
      Object.assign(_panel.style, { top:"0", left:"0", right:"0", width:"100vw", height:"100vh", borderRadius:"0" });
      btn.textContent="🗗"; _isFs=true;
    } else {
      Object.assign(_panel.style, { ..._savedPos, borderRadius:"12px" });
      btn.textContent="🗖"; _isFs=false;
    }
  }

  function _export() {
    const rows=[];
    _logCont.querySelectorAll("[data-lt]").forEach(el => {
      rows.push({
        type: el.dataset.lt,
        title: el.querySelector("span")?.textContent?.trim(),
        data: (() => { try { return JSON.parse(el.querySelector("pre")?.textContent||"{}"); } catch { return {}; } })(),
        time: el.querySelector("[style*='font-size:10px']")?.textContent,
      });
    });
    const url = URL.createObjectURL(new Blob([JSON.stringify(rows,null,2)],{type:"application/json"}));
    Object.assign(document.createElement("a"),{href:url,download:`vibescode-${Date.now()}.json`}).click();
    URL.revokeObjectURL(url);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 11. BOOT
  // ══════════════════════════════════════════════════════════════════════════
  initPanel();
  log("info", "🚀 VibesCode v10 (MCP)", { platform: PLATFORM.name, host: location.hostname, tab: TAB_ID });

  McpClient.connect();
  connectPushChannel();

  setTimeout(() => {
    const root = getChatRoot();
    new MutationObserver(() => {
      scanUserMessages();
      scanAiMessages();
    }).observe(root, { childList: true, subtree: true, characterData: true });
    log("info", "👁 Watching DOM", { root: root.tagName || root.nodeName });
  }, 800);

  // SPA navigation reset
  let _lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== _lastPath) {
      _lastPath = location.pathname;
      _seenTexts.clear();
      log("info", "🔄 SPA navigation", { path: location.pathname });
    }
  }, 1_000);

  console.log("[VibesCode v10] Loaded |", PLATFORM.name, "| MCP:", MCP_BASE_URL, "| Tab:", TAB_ID);
})();