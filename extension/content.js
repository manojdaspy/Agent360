// content.js — VibesCode Agent v12
// ════════════════════════════════════════════════════════════════════════════
// v12 improvements over v11:
//   • Heartbeat now reports send_button_status (active/disabled/not_found)
//   • Heartbeat reports input_empty, bot_typing, page_url
//   • llm_state is now derived from all signals combined (more accurate)
//   • Path input: user can paste any absolute path into the panel to set root
//   • list_mcp_tools: panel shows /tools list on click
//   • Shell input: inline shell runner in the panel (power users)
//   • Status bar shows send button state and generating indicator live
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
  const HEARTBEAT_URL = `${MCP_BASE_URL}/ext/heartbeat`;

  const TAB_ID = Math.random().toString(36).slice(2, 10);
  const HEARTBEAT_INTERVAL_MS = 2000;

  // ══════════════════════════════════════════════════════════════════════════
  // 1. PLATFORM SELECTORS
  // ══════════════════════════════════════════════════════════════════════════
  const PLATFORMS = [
    {
      name:    "ChatGPT",
      match:   h => h.includes("chatgpt.com") || h.includes("chat.openai.com"),
      userMsg: '[data-message-author-role="user"] .whitespace-pre-wrap',
      aiMsg:   '[data-message-author-role="assistant"] .markdown',
      input:   '#prompt-textarea',
      sendBtns: [
        '[data-testid="send-button"]:not([disabled])',
        'button[aria-label="Send message"]:not([disabled])',
        'button[aria-label="Send prompt"]:not([disabled])',
        'form button[type="submit"]:not([disabled])',
      ],
      // Also check for disabled version to report status accurately
      sendBtnAny: [
        '[data-testid="send-button"]',
        'button[aria-label="Send message"]',
        'button[aria-label="Send prompt"]',
      ],
      chatRoot: 'main',
      sendKeys: [{ key: "Enter", code: "Enter", keyCode: 13 }],
    },
    {
      name:    "Claude",
      match:   h => h.includes("claude.ai"),
      userMsg: '[data-testid="user-message"]',
      aiMsg:   '[data-testid="assistant-message"] .whitespace-pre-wrap',
      input:   'div[contenteditable="true"][data-placeholder]',
      sendBtns: [
        'button[aria-label="Send message"]:not([disabled])',
        'button[aria-label="Send Message"]:not([disabled])',
        'button[type="submit"]:not([disabled])',
        '[data-testid="send-button"]:not([disabled])',
      ],
      sendBtnAny: [
        'button[aria-label="Send message"]',
        'button[aria-label="Send Message"]',
        'button[type="submit"]',
        '[data-testid="send-button"]',
      ],
      chatRoot: '[data-testid="conversation-turn-list"]',
      sendKeys: [{ key: "Enter", code: "Enter", keyCode: 13 }],
    },
    {
      name:    "Gemini",
      match:   h => h.includes("gemini.google.com"),
      userMsg: 'user-query .query-text',
      aiMsg:   'model-response .markdown',
      input:   'rich-textarea div[contenteditable="true"]',
      sendBtns: [
        'button.send-button:not([disabled])',
        'button[aria-label="Send message"]:not([disabled])',
        'button[mattooltip="Send message"]:not([disabled])',
        'button[aria-label="Submit"]:not([disabled])',
        '.send-button:not([disabled])',
        'mat-icon-button[type="submit"]:not([disabled])',
        'button[type="submit"]:not([disabled])',
      ],
      sendBtnAny: [
        'button.send-button',
        'button[aria-label="Send message"]',
        '.send-button',
        'button[type="submit"]',
      ],
      chatRoot: 'chat-history',
      sendKeys: [
        { key: "Enter", code: "Enter", keyCode: 13, ctrlKey: false },
        { key: "Enter", code: "Enter", keyCode: 13, ctrlKey: true },
      ],
    },
    {
      name:    "Perplexity",
      match:   h => h.includes("perplexity.ai"),
      userMsg: '[data-testid="user-message"]',
      aiMsg:   '.prose',
      input:   'textarea',
      sendBtns: [
        'button[aria-label="Submit"]:not([disabled])',
        'button[type="submit"]:not([disabled])',
        'button.bg-super:not([disabled])',
      ],
      sendBtnAny: [
        'button[aria-label="Submit"]',
        'button[type="submit"]',
      ],
      chatRoot: 'main',
      sendKeys: [{ key: "Enter", code: "Enter", keyCode: 13 }],
    },
    {
      name:    "Generic",
      match:   () => true,
      userMsg: '.user-message, .human-turn, [class*="user-turn"]',
      aiMsg:   '.assistant-message, .bot-message, [class*="assistant-turn"]',
      input:   'div[contenteditable="true"], textarea',
      sendBtns: [
        'button[aria-label="Send message"]:not([disabled])',
        'button[type="submit"]:not([disabled])',
        'button[aria-label="Submit"]:not([disabled])',
      ],
      sendBtnAny: [
        'button[aria-label="Send message"]',
        'button[type="submit"]',
        'button[aria-label="Submit"]',
      ],
      chatRoot: 'main, body',
      sendKeys: [{ key: "Enter", code: "Enter", keyCode: 13 }],
    },
  ];

  const PLATFORM = PLATFORMS.find(p => p.match(location.hostname));
  console.log("[VibesCode v12] Platform:", PLATFORM.name);

  // ══════════════════════════════════════════════════════════════════════════
  // 2. DOM HELPERS
  // ══════════════════════════════════════════════════════════════════════════
  const $  = (sel, root = document) => { try { return root.querySelector(sel); } catch { return null; } };
  const $$ = (sel, root = document) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };

  const getInput = () => {
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

  const getSendBtn = () => {
    for (const sel of PLATFORM.sendBtns) {
      const btn = $(sel);
      if (btn && isVisible(btn) && !btn.disabled) return btn;
    }
    const allBtns = $$('button:not([disabled])');
    for (const btn of allBtns) {
      const label = (btn.getAttribute('aria-label') || btn.title || btn.textContent || "").toLowerCase();
      if (/send|submit|go/.test(label) && isVisible(btn)) return btn;
    }
    return null;
  };

  // Check for send button in ANY state (active or disabled) for status reporting
  const getSendBtnAny = () => {
    const anySelectors = PLATFORM.sendBtnAny || [];
    for (const sel of anySelectors) {
      const btn = $(sel);
      if (btn && isVisible(btn)) return btn;
    }
    // Fallback: look for disabled submit buttons
    const allBtns = $$('button');
    for (const btn of allBtns) {
      const label = (btn.getAttribute('aria-label') || btn.title || btn.textContent || "").toLowerCase();
      if (/send|submit/.test(label) && isVisible(btn)) return btn;
    }
    return null;
  };

  // Returns "active" | "disabled" | "not_found"
  const getSendButtonStatus = () => {
    const activeBtn = getSendBtn();
    if (activeBtn) return "active";
    const anyBtn = getSendBtnAny();
    if (anyBtn) return "disabled";
    return "not_found";
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
    $('loading-indicator:not([hidden])') ||
    $('.loading-indicator-container:not([hidden])')
  );

  const isInputEmpty = () => {
    const input = getInput();
    if (!input) return true;
    const val = input.isContentEditable ? (input.innerText || "").trim() : (input.value || "").trim();
    return val.length === 0;
  };

  // Derive a unified llm_state from all signals
  const deriveLlmState = () => {
    if (_busy) return "injecting";
    if (isBotTyping()) return "generating";
    const btnStatus = getSendButtonStatus();
    const empty = isInputEmpty();
    if (empty && btnStatus === "disabled") return "idle";
    if (empty && btnStatus === "active") return "injectable";
    if (!empty) return "idle"; // user has typed something
    return "idle";
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 3. TEXT INJECTION
  // ══════════════════════════════════════════════════════════════════════════
  async function injectText(input, text) {
    input.focus();
    await sleep(80);
    if (tryExecCommand(input, text)) {
      log("info", "📝 Injected via execCommand", { chars: text.length });
      return true;
    }
    if (tryInputEvent(input, text)) {
      log("info", "📝 Injected via InputEvent", { chars: text.length });
      return true;
    }
    if (await tryClipboardPaste(input, text)) {
      log("info", "📝 Injected via clipboard paste", { chars: text.length });
      return true;
    }
    forceAssign(input, text);
    log("warn", "📝 Injected via force-assign", { chars: text.length });
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
    } catch { }
    return false;
  }

  function tryInputEvent(input, text) {
    try {
      if (input.isContentEditable) {
        input.innerHTML = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        input.dispatchEvent(new InputEvent("input", {
          bubbles: true, cancelable: true,
          inputType: "insertFromPaste",
          data: text,
          dataTransfer: dt,
        }));
        if (!getInputValue(input)) {
          const node = document.createTextNode(text);
          input.appendChild(node);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else {
        const nativeSetter =
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set ||
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
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
      await navigator.clipboard.writeText(text);
      input.focus();
      await sleep(60);
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      input.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true, cancelable: true, clipboardData: dt,
      }));
      await sleep(80);
      if (getInputValue(input).length > 0) return true;
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
    ["input", "change", "keyup", "keydown"].forEach(ev =>
      input.dispatchEvent(new Event(ev, { bubbles: true }))
    );
  }

  function getInputValue(input) {
    return (input.isContentEditable ? input.innerText : input.value) || "";
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. SEND BUTTON
  // ══════════════════════════════════════════════════════════════════════════
  async function triggerSend(input) {
    const btn = await pollForSendButton(6000);
    if (btn) {
      btn.focus();
      btn.click();
      log("info", "📨 Sent via button.click()", { button: btn.getAttribute("aria-label") || btn.className });
      return true;
    }
    log("warn", "⚠️ Send button not found — trying keyboard fallbacks");
    for (const keyOpts of (PLATFORM.sendKeys || [])) {
      dispatchKey(input, keyOpts);
      await sleep(120);
      if (getInputValue(input).length === 0) {
        log("info", "📨 Sent via keyboard shortcut", { key: keyOpts.key });
        return true;
      }
    }
    dispatchKey(input, { key: "Enter", code: "Enter", keyCode: 13 });
    await sleep(200);
    if (getInputValue(input).length === 0) {
      log("info", "📨 Sent via Enter fallback");
      return true;
    }
    log("error", "❌ All send strategies failed");
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

  function pollForSendButton(timeoutMs) {
    return new Promise(resolve => {
      const btn = getSendBtn();
      if (btn) return resolve(btn);
      let resolved = false;
      const mo = new MutationObserver(() => {
        if (resolved) return;
        const b = getSendBtn();
        if (b) { resolved = true; mo.disconnect(); clearTimeout(timer); resolve(b); }
      });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "aria-disabled"] });
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
  // 5. typeIntoInput
  // ══════════════════════════════════════════════════════════════════════════
  async function typeIntoInput(text, submit = true) {
    await waitUntil(() => !isBotTyping(), 60_000);
    await sleep(300);
    const input = getInput();
    if (!input) {
      log("error", "⚠️ No input box found", { platform: PLATFORM.name });
      return false;
    }
    await injectText(input, text);
    await sleep(150);
    if (!submit) return true;
    const sent = await triggerSend(input);
    return sent;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. MCP CLIENT
  // ══════════════════════════════════════════════════════════════════════════
  const McpClient = (() => {
    let _sessionPostUrl = null;
    let _pendingCalls   = new Map();
    let _nextId         = 1;
    let _initialized    = false;
    let _sseSource      = null;
    let _backoffMs      = 1000;

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
        catch { log("error", "⚠️ MCP parse error", { raw: e.data }); return; }
        _handleRpcResponse(msg);
      });
      _sseSource.onerror = () => {
        log("error", `❌ MCP SSE error — reconnecting in ${_backoffMs}ms`, {});
        _sseSource.close();
        _initialized = false;
        _sessionPostUrl = null;
        updateMcpBadge(false);
        setTimeout(() => { _backoffMs = Math.min(_backoffMs * 2, 30_000); connect(); }, _backoffMs);
      };
      _sseSource.onopen = () => { _backoffMs = 1000; };
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
          clientInfo: { name: "vibescode-extension", version: "12.0.0" },
        });
        _initialized = true;
        updateMcpBadge(true);
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
  // 7. HEARTBEAT — sends rich state every 2s
  // ══════════════════════════════════════════════════════════════════════════
  function startHeartbeat() {
    setInterval(async () => {
      const llmState = deriveLlmState();
      const btnStatus = getSendButtonStatus();
      const empty = isInputEmpty();
      const typing = isBotTyping();

      // Update panel status bar
      updateStatusBar(llmState, btnStatus);

      try {
        await fetch(HEARTBEAT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tab_id:             TAB_ID,
            platform:           PLATFORM.name,
            llm_state:          llmState,
            send_button_status: btnStatus,
            input_empty:        empty,
            bot_typing:         typing,
            page_url:           location.href,
            mcp_ready:          McpClient.isReady(),
          }),
        });
      } catch { /* non-critical */ }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. AI OUTPUT SCANNER
  // ══════════════════════════════════════════════════════════════════════════
  const OP_TO_TOOL = {
    cat: "cat", read: "cat", read_file: "cat",
    tree: "tree",
    dir: "dir", dir_list: "dir_list", ls: "dir_list",
    search: "search", grep: "search",
    write: "write", write_file: "write",
    patch: "patch", edit: "patch",
    mkdir: "mkdir",
    delete: "delete", rm: "delete",
    shell: "shell", run: "shell", bash: "shell", exec: "shell",
    run_tests: "run_tests", pytest: "run_tests", test: "run_tests",
    lint: "lint", flake8: "lint", eslint: "lint",
    git_status: "git_status", status: "git_status",
    git_diff: "git_diff", diff: "git_diff",
    git_log: "git_log", log: "git_log",
    get_root: "get_root",
    set_root: "set_root",
    detect_root: "detect_root",
    project_info: "project_info",
    list_mcp_tools: "list_mcp_tools",
  };

  const _seenNodes = new WeakSet();
  const _seenTexts = new Set();
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
    // Join ALL message nodes to fix split-node parse errors (Gemini, Claude)
    const nodes = $$(PLATFORM.aiMsg);
    const joined = nodes.map(el => (el.innerText || "").trim()).join("\n");
    if (!joined) return;

    // Check each node individually for new content
    nodes.forEach(el => {
      if (_seenNodes.has(el)) return;
      const text = (el.innerText || "").trim();
      if (!text || text.length < 4) return;
      const fp = "a:" + text.slice(0, 200);
      if (_seenTexts.has(fp)) return;
      _seenNodes.add(el);
      _seenTexts.add(fp);
      log("ai", "🤖 AI", { message: text.length > 300 ? text.slice(0, 300) + "…" : text });
    });

    // Parse AGENT_CALLs from joined text (prevents split-node miss)
    for (const line of joined.split("\n")) {
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
      break; // one per scan
    }
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
  // 9. PUSH CHANNEL
  // ══════════════════════════════════════════════════════════════════════════
  function connectPushChannel() {
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
        try {
          await fetch(PUSH_ACK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tab: TAB_ID, id: msgId, sent }),
          });
        } catch { }
      });
      es.onerror = () => {
        es.close();
        setTimeout(() => { backoff = Math.min(backoff * 2, 30_000); open(); }, backoff);
      };
      es.onopen = () => { backoff = 1000; };
    }
    open();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 10. UTILITIES
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
  // 11. TERMINAL PANEL
  // ══════════════════════════════════════════════════════════════════════════
  let _panel    = null;
  let _logCont  = null;
  let _filter   = "all";
  let _isFs     = false;
  let _savedPos = { top:"20px", right:"20px", left:"auto", width:"460px", height:"600px" };

  const TSTYLE = {
    request: { bg:"#1e1e2e", border:"#89b4fa", hBg:"#89b4fa22", c:"#89b4fa" },
    success: { bg:"#1b2b24", border:"#a6e3a1", hBg:"#a6e3a122", c:"#a6e3a1" },
    error:   { bg:"#2a1a1c", border:"#f38ba8", hBg:"#f38ba822", c:"#f38ba8" },
    warn:    { bg:"#2a2310", border:"#f9e2af", hBg:"#f9e2af22", c:"#f9e2af" },
    info:    { bg:"#1e1e2e", border:"#cba6f7", hBg:"#cba6f722", c:"#cba6f7" },
    user:    { bg:"#1a1a2e", border:"#f9e2af", hBg:"#f9e2af22", c:"#f9e2af" },
    ai:      { bg:"#1a2a1a", border:"#94e2d5", hBg:"#94e2d522", c:"#94e2d5" },
  };

  const LLM_STATE_COLORS = {
    generating:  "#f38ba8",
    idle:        "#6c7086",
    injectable:  "#a6e3a1",
    injecting:   "#89b4fa",
    unknown:     "#6c7086",
  };

  const BTN_STATE_COLORS = {
    active:     "#a6e3a1",
    disabled:   "#f9e2af",
    not_found:  "#f38ba8",
    unknown:    "#6c7086",
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

    // Header
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
        <span id="vbc-mcp-badge" style="font-size:9px;padding:2px 6px;border-radius:10px;background:#2a1a3e;color:#89b4fa;margin-left:2px;">v12</span>
      </div>
      <div style="display:flex;gap:4px;align-items:center;">
        <button id="vbc-tools-btn" title="List MCP tools" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">🔧</button>
        <button id="vbc-path-btn" title="Set project path" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">📁</button>
        <button id="vbc-shell-btn" title="Run shell command" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">$_</button>
        <button id="vbc-clear" title="Clear logs" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">🗑</button>
        <button id="vbc-export" title="Export logs" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">💾</button>
        <button id="vbc-fs" title="Fullscreen" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 9px;font-size:10px;cursor:pointer;font-weight:bold;">🗖</button>
      </div>`;

    // Rich status bar
    const statusBar = document.createElement("div");
    statusBar.style.cssText = "padding:4px 12px;background:#11111b;border-bottom:1px solid #1e1e2e;font-size:10px;color:#6c7086;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;gap:8px;";
    statusBar.innerHTML = `
      <span id="vbc-status">⏳ Connecting…</span>
      <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">
        <span id="vbc-llm-state" style="font-size:9px;padding:1px 5px;border-radius:8px;background:#313244;color:#6c7086;">LLM: unknown</span>
        <span id="vbc-btn-state" style="font-size:9px;padding:1px 5px;border-radius:8px;background:#313244;color:#6c7086;">BTN: unknown</span>
        <span id="vbc-calls">🔧 0 calls</span>
      </div>`;

    // Quick-input bar (for path / shell)
    const quickBar = document.createElement("div");
    quickBar.id = "vbc-quick-bar";
    quickBar.style.cssText = "padding:6px 10px;background:#11111b;border-bottom:1px solid #1e1e2e;display:none;flex-shrink:0;";
    quickBar.innerHTML = `
      <div style="display:flex;gap:6px;align-items:center;">
        <span id="vbc-quick-label" style="font-size:10px;color:#6c7086;min-width:60px;">Path:</span>
        <input id="vbc-quick-input" type="text" placeholder="Paste path or command…"
          style="flex:1;background:#1e1e2e;border:1px solid #313244;border-radius:4px;color:#cdd6f4;font-family:monospace;font-size:10px;padding:4px 8px;outline:none;" />
        <button id="vbc-quick-run" style="background:#a6e3a1;color:#1e1e2e;border:none;border-radius:4px;padding:3px 8px;font-size:10px;cursor:pointer;font-weight:bold;">Run</button>
        <button id="vbc-quick-close" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 6px;font-size:10px;cursor:pointer;">✕</button>
      </div>`;

    // Tabs
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
    _panel.appendChild(quickBar);
    _panel.appendChild(tabs);
    _panel.appendChild(_logCont);
    document.body.appendChild(_panel);

    _makeDraggable(_panel, hdr);

    // Button handlers
    document.getElementById("vbc-fs").addEventListener("click", e => { e.stopPropagation(); _toggleFs(); });
    document.getElementById("vbc-clear").addEventListener("click", e => { e.stopPropagation(); _logCont.innerHTML = ""; });
    document.getElementById("vbc-export").addEventListener("click", e => { e.stopPropagation(); _export(); });

    // Path button
    document.getElementById("vbc-path-btn").addEventListener("click", e => {
      e.stopPropagation();
      _showQuickBar("Path:", "Paste project path (e.g. /home/user/myapp)", async (val) => {
        if (!val) return;
        const result = await McpClient.callTool("detect_root", { hint: val });
        log("success", "📁 Root set", { result: result.text });
      });
    });

    // Shell button
    document.getElementById("vbc-shell-btn").addEventListener("click", e => {
      e.stopPropagation();
      _showQuickBar("$ Shell:", "Enter shell command…", async (val) => {
        if (!val) return;
        log("info", `🖥 Running: ${val}`, {});
        const result = await McpClient.callTool("shell", { cmd: val });
        log(result.ok ? "success" : "error", `$ ${val}`, { output: result.text });
      });
    });

    // Tools list button
    document.getElementById("vbc-tools-btn").addEventListener("click", async e => {
      e.stopPropagation();
      try {
        const resp = await fetch(`${MCP_BASE_URL}/tools`);
        const data = await resp.json();
        const lines = (data.tools || []).map(t => `• ${t.name}: ${t.description}`).join("\n");
        log("info", `🔧 ${data.total} tools registered`, { tools: lines });
      } catch (err) {
        log("error", "❌ Could not fetch tools", { error: err.message });
      }
    });

    // Tab filter
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

    // Quick bar run/close
    document.getElementById("vbc-quick-run").addEventListener("click", async () => {
      const val = document.getElementById("vbc-quick-input").value.trim();
      if (_quickCallback) await _quickCallback(val);
      _hideQuickBar();
    });
    document.getElementById("vbc-quick-close").addEventListener("click", _hideQuickBar);
    document.getElementById("vbc-quick-input").addEventListener("keydown", async e => {
      if (e.key === "Enter") {
        const val = e.target.value.trim();
        if (_quickCallback) await _quickCallback(val);
        _hideQuickBar();
      }
      if (e.key === "Escape") _hideQuickBar();
    });
  }

  let _quickCallback = null;

  function _showQuickBar(label, placeholder, callback) {
    const bar = document.getElementById("vbc-quick-bar");
    const inp = document.getElementById("vbc-quick-input");
    const lbl = document.getElementById("vbc-quick-label");
    if (!bar) return;
    lbl.textContent = label;
    inp.placeholder = placeholder;
    inp.value = "";
    bar.style.display = "block";
    inp.focus();
    _quickCallback = callback;
  }

  function _hideQuickBar() {
    const bar = document.getElementById("vbc-quick-bar");
    if (bar) bar.style.display = "none";
    _quickCallback = null;
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

  function updateStatus(txt)      { const e = document.getElementById("vbc-status");  if (e) e.textContent = txt; }
  function updateCallCount(n)     { const e = document.getElementById("vbc-calls");   if (e) e.textContent = `🔧 ${n} call${n!==1?"s":""}`; }
  function updateMcpBadge(ready)  { const e = document.getElementById("vbc-mcp-badge"); if (e) { e.style.color = ready ? "#a6e3a1" : "#f38ba8"; e.textContent = ready ? "MCP ✓" : "MCP ✗"; } }

  function updateStatusBar(llmState, btnStatus) {
    const llmEl = document.getElementById("vbc-llm-state");
    const btnEl = document.getElementById("vbc-btn-state");
    if (llmEl) {
      llmEl.textContent = `LLM: ${llmState}`;
      llmEl.style.color = LLM_STATE_COLORS[llmState] || "#6c7086";
    }
    if (btnEl) {
      btnEl.textContent = `BTN: ${btnStatus}`;
      btnEl.style.color = BTN_STATE_COLORS[btnStatus] || "#6c7086";
    }
  }

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
  // 12. BOOT
  // ══════════════════════════════════════════════════════════════════════════
  initPanel();
  log("info", "🚀 VibesCode v12 (MCP)", { platform: PLATFORM.name, host: location.hostname, tab: TAB_ID });

  McpClient.connect();
  connectPushChannel();
  startHeartbeat();

  setTimeout(() => {
    const root = getChatRoot();
    new MutationObserver(() => {
      scanUserMessages();
      scanAiMessages();
    }).observe(root, { childList: true, subtree: true, characterData: true });
    log("info", "👁 Watching DOM", { root: root.tagName || root.nodeName });
  }, 800);

  let _lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== _lastPath) {
      _lastPath = location.pathname;
      _seenTexts.clear();
      log("info", "🔄 SPA navigation", { path: location.pathname });
    }
  }, 1_000);

  console.log("[VibesCode v12] Loaded |", PLATFORM.name, "| MCP:", MCP_BASE_URL, "| Tab:", TAB_ID);
})();