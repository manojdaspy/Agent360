// content.js — VibesCode Agent v13 (Final+)
// ════════════════════════════════════════════════════════════════════════════
// Improvements over v12:
//   • Background tab — detailed event log for EVERYTHING the agent does
//   • Tool tab — only shows MCP hit / waiting / received
//   • Panel is resizable (drag any edge/corner) and hideable (toggle button)
//   • Path normalization: \\ and \ → / (fixes Windows parse errors)
//   • cat results are NEVER chunked — full content injected as one message
//   • All ops have clear logging at every lifecycle stage
// ════════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  // ══════════════════════════════════════════════════════════════════════════
  // 0. CONFIG
  // ══════════════════════════════════════════════════════════════════════════
  const MCP_BASE_URL   = "https://studentassignment.lyralogics.com";
  const MCP_SSE_URL    = `${MCP_BASE_URL}/mcp/sse`;
  const PUSH_SSE_URL   = `${MCP_BASE_URL}/push/stream`;
  const PUSH_ACK_URL   = `${MCP_BASE_URL}/push/ack`;
  const HEARTBEAT_URL  = `${MCP_BASE_URL}/ext/heartbeat`;

  const TAB_ID                = Math.random().toString(36).slice(2, 10);
  const HEARTBEAT_INTERVAL_MS = 2000;
  const TOOL_CALL_TIMEOUT_MS  = 30_000;
  // Only ops that are NOT cat will be chunked
  const CHUNK_SIZE            = 4000;

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
  console.log("[VibesCode v13+] Platform:", PLATFORM.name);

  // ══════════════════════════════════════════════════════════════════════════
  // PATH NORMALIZATION — fix Windows backslash paths
  // ══════════════════════════════════════════════════════════════════════════
  function normalizePath(str) {
    if (typeof str !== "string") return str;
    // Double backslash → single backslash → forward slash
    return str.replace(/\\\\/g, "/").replace(/\\/g, "/");
  }

  function normalizeCallPaths(call) {
    const pathKeys = ["path", "hint", "cwd", "old_str", "new_str"];
    const result = { ...call };
    for (const key of pathKeys) {
      if (typeof result[key] === "string") {
        result[key] = normalizePath(result[key]);
      }
    }
    return result;
  }

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
    const buttons = $$("button");
    for (const btn of buttons) {
      const rect = btn.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) continue;
      if (!isVisible(btn) || btn.disabled) continue;
      const svg = btn.querySelector("svg");
      if (svg) {
        const txt = (btn.innerText + (btn.ariaLabel || "") + (btn.title || "")).toLowerCase();
        if (/send|submit|arrow|up/.test(txt)) return btn;
      }
    }
    const allBtns = $$('button:not([disabled])');
    for (const btn of allBtns) {
      const label = (btn.getAttribute('aria-label') || btn.title || btn.textContent || "").toLowerCase();
      if (/send|submit|go/.test(label) && isVisible(btn)) return btn;
    }
    return null;
  };

  const getSendBtnAny = () => {
    const anySelectors = PLATFORM.sendBtnAny || [];
    for (const sel of anySelectors) {
      const btn = $(sel);
      if (btn && isVisible(btn)) return btn;
    }
    const allBtns = $$('button');
    for (const btn of allBtns) {
      const label = (btn.getAttribute('aria-label') || btn.title || btn.textContent || "").toLowerCase();
      if (/send|submit/.test(label) && isVisible(btn)) return btn;
    }
    return null;
  };

  const getSendButtonStatus = () => {
    if (getSendBtn()) return "active";
    if (getSendBtnAny()) return "disabled";
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

  const deriveLlmState = () => {
    if (_busy) return "injecting";
    if (isBotTyping()) return "generating";
    const btnStatus = getSendButtonStatus();
    const empty = isInputEmpty();
    if (empty && btnStatus === "disabled") return "idle";
    if (empty && btnStatus === "active") return "injectable";
    if (!empty) return "idle";
    return "idle";
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 3. TEXT INJECTION
  // ══════════════════════════════════════════════════════════════════════════
  async function injectText(input, text) {
    input.focus();
    await sleep(80);
    if (tryExecCommand(input, text)) {
      bgLog("inject", "📝 Injected via execCommand", { chars: text.length });
      return true;
    }
    if (tryInputEvent(input, text)) {
      bgLog("inject", "📝 Injected via InputEvent", { chars: text.length });
      return true;
    }
    if (await tryClipboardPaste(input, text)) {
      bgLog("inject", "📝 Injected via clipboard paste", { chars: text.length });
      return true;
    }
    forceAssign(input, text);
    bgLog("warn", "📝 Injected via force-assign (fallback)", { chars: text.length });
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
    bgLog("inject", "🖱️ Looking for send button...", {});
    const btn = await pollForSendButton(6000);
    if (btn) {
      bgLog("inject", "🖱️ Clicking send button", { label: btn.getAttribute("aria-label") || btn.className });
      btn.focus();
      btn.click();
      return true;
    }
    bgLog("warn", "⚠️ Send button not found — trying keyboard fallbacks", {});
    for (const keyOpts of (PLATFORM.sendKeys || [])) {
      dispatchKey(input, keyOpts);
      await sleep(120);
      if (getInputValue(input).length === 0) {
        bgLog("inject", "⌨️ Sent via keyboard shortcut", { key: keyOpts.key });
        return true;
      }
    }
    dispatchKey(input, { key: "Enter", code: "Enter", keyCode: 13 });
    await sleep(200);
    if (getInputValue(input).length === 0) {
      bgLog("inject", "⌨️ Sent via Enter fallback", {});
      return true;
    }
    bgLog("error", "❌ All send strategies failed", {});
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
    bgLog("inject", "⏳ Waiting for AI to finish (if generating)...", {});
    await waitUntil(() => !isBotTyping(), 60_000);
    await sleep(300);
    const input = getInput();
    if (!input) {
      bgLog("error", "⚠️ No input box found", { platform: PLATFORM.name });
      return false;
    }
    bgLog("inject", "✍️ Injecting text into input", { chars: text.length, preview: text.slice(0, 80) });
    await injectText(input, text);
    await sleep(150);
    if (!submit) return true;
    const sent = await triggerSend(input);
    if (sent) bgLog("inject", "✅ Message submitted successfully", {});
    else bgLog("error", "❌ Message submission failed", {});
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
      bgLog("mcp", "🔌 Connecting to MCP SSE...", { url: MCP_SSE_URL });
      _sseSource = new EventSource(MCP_SSE_URL);
      _sseSource.addEventListener("endpoint", async (e) => {
        const raw = e.data.trim();
        _sessionPostUrl = raw.startsWith("http")
          ? raw
          : MCP_BASE_URL.replace(/\/$/, "") + raw;
        bgLog("mcp", "📡 MCP session endpoint received", { url: _sessionPostUrl });
        await _initialize();
      });
      _sseSource.addEventListener("message", (e) => {
        let msg;
        try { msg = JSON.parse(e.data); }
        catch { bgLog("error", "⚠️ MCP parse error", { raw: e.data }); return; }
        _handleRpcResponse(msg);
      });
      _sseSource.onerror = () => {
        bgLog("error", `❌ MCP SSE error — reconnecting in ${_backoffMs}ms`, {});
        _sseSource.close();
        _initialized = false;
        _sessionPostUrl = null;
        updateMcpBadge(false);
        setTimeout(() => { _backoffMs = Math.min(_backoffMs * 2, 30_000); connect(); }, _backoffMs);
      };
      _sseSource.onopen = () => { _backoffMs = 1000; bgLog("mcp", "🟢 MCP SSE connection opened", {}); };
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
        bgLog("mcp", "🤝 Initializing MCP protocol...", {});
        await _send("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "vibescode-extension", version: "13.0.0" },
        });
        _initialized = true;
        updateMcpBadge(true);
        updateStatus("✅ MCP Ready");
        bgLog("success", "✅ MCP initialized and ready", { server: MCP_BASE_URL });
      } catch (err) {
        bgLog("error", "❌ MCP initialize failed", { error: err.message });
      }
    }

    async function callTool(name, args = {}) {
      if (!_initialized) throw new Error("MCP not ready");

      // Log: hitting MCP (shown in Tool tab too)
      toolLog("hit", `📡 HIT MCP: ${name}`, { args });
      bgLog("mcp", `📤 Calling MCP tool: ${name}`, { args });

      // Log: waiting
      toolLog("waiting", `⏳ WAITING for MCP: ${name}`, {});
      bgLog("mcp", `⌛ Waiting for MCP result: ${name}...`, {});

      const result = await Promise.race([
        _send("tools/call", { name, arguments: args }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Tool call timed out after ${TOOL_CALL_TIMEOUT_MS / 1000}s`)), TOOL_CALL_TIMEOUT_MS)
        ),
      ]);

      const text = result?.content?.[0]?.text ?? JSON.stringify(result);
      const ok   = !result?.isError;

      if (ok) {
        toolLog("received", `✅ RECEIVED from MCP: ${name}`, { chars: text.length, preview: text.slice(0, 200) });
        bgLog("success", `✅ MCP result received: ${name}`, { chars: text.length, preview: text.slice(0, 300) });
      } else {
        toolLog("error", `❌ MCP ERROR: ${name}`, { error: text });
        bgLog("error", `❌ MCP tool error: ${name}`, { error: text });
      }

      return { ok, text, raw: result };
    }

    return { connect, callTool, isReady: () => _initialized };
  })();

  // ══════════════════════════════════════════════════════════════════════════
  // 7. HEARTBEAT
  // ══════════════════════════════════════════════════════════════════════════
  let HEARTBEAT_FAILURES = 0;

  function startHeartbeat() {
    setInterval(async () => {
      const llmState  = deriveLlmState();
      const btnStatus = getSendButtonStatus();
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
            input_empty:        isInputEmpty(),
            bot_typing:         isBotTyping(),
            page_url:           location.href,
            mcp_ready:          McpClient.isReady(),
          }),
        });
        if (HEARTBEAT_FAILURES > 0) {
          HEARTBEAT_FAILURES = 0;
          updateStatus("✅ Heartbeat restored");
        }
      } catch {
        HEARTBEAT_FAILURES++;
        if (HEARTBEAT_FAILURES > 5) updateStatus("⚠️ Heartbeat offline");
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. TOOL EXECUTION HISTORY
  // ══════════════════════════════════════════════════════════════════════════
  const TOOL_HISTORY = [];

  function addHistory(entry) {
    TOOL_HISTORY.unshift({ time: Date.now(), ...entry });
    if (TOOL_HISTORY.length > 100) TOOL_HISTORY.length = 100;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 9. CHUNKING — only for non-cat ops
  // ══════════════════════════════════════════════════════════════════════════
  const NO_CHUNK_OPS = new Set(["cat", "read", "read_file"]);

  function chunkText(text, size = CHUNK_SIZE) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) {
      chunks.push(text.slice(i, i + size));
    }
    return chunks;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 10. AI OUTPUT SCANNER
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
    template_prompt: "template_prompt",
    cat_range: "cat_range",
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
    if (isBotTyping()) return;

    const nodes  = $$(PLATFORM.aiMsg);
    const joined = nodes.map(el => (el.innerText || "").trim()).join("\n");
    if (!joined) return;

    nodes.forEach(el => {
      if (_seenNodes.has(el)) return;
      const text = (el.innerText || "").trim();
      if (!text || text.length < 4) return;
      const fp = "a:" + text.slice(0, 200);
      if (_seenTexts.has(fp)) return;
      _seenNodes.add(el);
      _seenTexts.add(fp);
      bgLog("ai", "🤖 AI message detected", { preview: text.length > 300 ? text.slice(0, 300) + "…" : text });
    });

    for (const line of joined.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("AGENT_CALL")) continue;
      bgLog("dom", "🔍 DOM: AGENT_CALL detected in AI message", { raw: trimmed.slice(0, 120) });
      const jsonPart = trimmed.replace(/^AGENT_CALL\s*:?\s*/, "");
      let call;
      try { call = JSON.parse(jsonPart); }
      catch {
        bgLog("error", "⚠️ AGENT_CALL JSON parse error — attempting path fix", { line: trimmed });
        // Try fixing common Windows path issues before giving up
        const fixed = jsonPart
          .replace(/\\\\/g, "/")
          .replace(/\\(?!["\\])/g, "/");
        try {
          call = JSON.parse(fixed);
          bgLog("success", "✅ AGENT_CALL recovered after path fix", { fixed: fixed.slice(0, 120) });
        } catch {
          bgLog("error", "❌ AGENT_CALL still unparseable after fix", { line: trimmed });
          continue;
        }
      }
      const callFp = JSON.stringify(call);
      if (_processed.has(callFp)) continue;
      _processed.add(callFp);

      // Normalize all path fields in the call
      const normalizedCall = normalizeCallPaths(call);
      if (JSON.stringify(normalizedCall) !== JSON.stringify(call)) {
        bgLog("dom", "🔧 Path normalized (backslash → forward slash)", {
          original: call.path || call.hint || "",
          normalized: normalizedCall.path || normalizedCall.hint || "",
        });
      }

      bgLog("dom", `📬 Queuing tool call: ${normalizedCall.op}`, { call: normalizedCall });
      enqueueToolCall(normalizedCall);
      break;
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
      bgLog("user", "👤 User input detected", { message: text.length > 200 ? text.slice(0, 200) + "…" : text });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 11. TOOL QUEUE
  // ══════════════════════════════════════════════════════════════════════════
  const TOOL_QUEUE = [];
  let PROCESSING_QUEUE = false;

  function enqueueToolCall(call) {
    TOOL_QUEUE.push(call);
    bgLog("queue", `📥 Enqueued: ${call.op} (queue depth: ${TOOL_QUEUE.length})`, {});
    processQueue();
  }

  async function processQueue() {
    if (PROCESSING_QUEUE) return;
    PROCESSING_QUEUE = true;
    while (TOOL_QUEUE.length > 0) {
      const call = TOOL_QUEUE.shift();
      bgLog("queue", `▶️ Processing: ${call.op} (${TOOL_QUEUE.length} remaining)`, {});
      try {
        await executeToolCall(call);
      } catch (err) {
        bgLog("error", `❌ Queue execution error: ${call.op}`, { error: err.message });
      }
    }
    PROCESSING_QUEUE = false;
    bgLog("queue", "✅ Queue empty — all done", {});
  }

  async function executeToolCall(call) {
    _busy = true;
    updateStatus(`🔧 ${call.op || call.name}`);
    bgLog("exec", `🚀 Executing: ${call.op}`, { call });

    const toolName = OP_TO_TOOL[call.op] || call.op || call.name;
    const isCatOp  = NO_CHUNK_OPS.has(call.op);
    const { op, name: _n, ...args } = call;

    let result;
    const startTime = Date.now();
    try {
      result = await McpClient.callTool(toolName, args);
    } catch (err) {
      result = { ok: false, text: err.message };
      bgLog("error", `❌ Tool call threw exception: ${toolName}`, { error: err.message });
    }

    addHistory({
      tool: toolName,
      args,
      ok: result.ok,
      duration: Date.now() - startTime,
      preview: (result.text || "").slice(0, 200),
    });

    _callCount++;
    updateCallCount(_callCount);

    const resultText = result.ok ? result.text : `ERROR: ${result.text}`;

    if (isCatOp) {
      // CAT: never chunk — inject full content in one shot
      bgLog("inject", `📄 cat result: injecting full content (${resultText.length} chars)`, {});
      updateStatus("⏳ Injecting cat result (full)…");
      const reply = `__TOOL_RESULT__\nop: ${toolName}\n${resultText}\n__END_RESULT__\n\nContinue based on the result above.`;
      const sent  = await typeIntoInput(reply, true);
      updateStatus(sent ? "✅ Done" : "⚠️ Send failed");
      bgLog(sent ? "success" : "error", sent ? `✅ cat inject done` : `❌ cat inject failed`, { chars: reply.length });
    } else {
      const chunks = chunkText(resultText, CHUNK_SIZE);
      if (chunks.length === 1) {
        updateStatus("⏳ Injecting result…");
        bgLog("inject", `💉 Injecting single-chunk result for ${toolName}`, { chars: resultText.length });
        const reply = `__TOOL_RESULT__\nop: ${toolName}\n${chunks[0]}\n__END_RESULT__\n\nContinue based on the result above.`;
        const sent  = await typeIntoInput(reply, true);
        updateStatus(sent ? "✅ Done" : "⚠️ Send failed");
        bgLog(sent ? "success" : "error", sent ? `✅ Inject done` : `❌ Inject failed`, {});
      } else {
        bgLog("inject", `📦 Multi-chunk inject: ${chunks.length} chunks for ${toolName}`, { totalChars: resultText.length });
        for (let i = 0; i < chunks.length; i++) {
          updateStatus(`⏳ Injecting chunk ${i + 1}/${chunks.length}…`);
          bgLog("inject", `📦 Injecting chunk ${i + 1}/${chunks.length}`, { chars: chunks[i].length });
          const isLast = i === chunks.length - 1;
          const header = i === 0 ? `__TOOL_RESULT__\nop: ${toolName}\n` : `[chunk ${i + 1}/${chunks.length}]\n`;
          const footer = isLast ? `\n__END_RESULT__\n\nContinue based on the result above.` : `\n[more chunks follow — wait for __END_RESULT__]`;
          const reply  = header + chunks[i] + footer;
          const sent   = await typeIntoInput(reply, true);
          if (!sent) { bgLog("error", `❌ Chunk ${i + 1} send failed`, {}); updateStatus("⚠️ Send failed mid-chunk"); break; }
          if (!isLast) await waitUntil(() => !isBotTyping(), 60_000);
        }
        updateStatus("✅ Done (chunked)");
      }
    }

    _busy = false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 12. PUSH CHANNEL
  // ══════════════════════════════════════════════════════════════════════════
  function connectPushChannel() {
    const url = `${PUSH_SSE_URL}?tab=${TAB_ID}`;
    bgLog("mcp", "📥 Connecting to push channel", { url, tab: TAB_ID });
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
        bgLog("push", "📥 Push message received", { preview: text.slice(0, 80), submit, id: msgId });
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
        bgLog("warn", "⚠️ Push channel SSE error — reconnecting", {});
        es.close();
        setTimeout(() => { backoff = Math.min(backoff * 2, 30_000); open(); }, backoff);
      };
      es.onopen = () => { backoff = 1000; bgLog("mcp", "🟢 Push channel connected", {}); };
    }
    open();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 13. UTILITIES
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
  // 14. PANEL — with Background tab, Tool tab, resize, hide/show
  // ══════════════════════════════════════════════════════════════════════════

  let _panel        = null;
  let _logCont      = null;
  let _bgLogCont    = null;   // background tab content
  let _toolLogCont  = null;   // tool tab content
  let _filter       = "all";
  let _activeTab    = "all";
  let _isFs         = false;
  let _isPanelHidden = false;
  let _savedPos     = { top: "20px", right: "20px", left: "auto", width: "480px", height: "620px" };

  const TSTYLE = {
    request: { bg:"#1e1e2e", border:"#89b4fa", hBg:"#89b4fa22", c:"#89b4fa" },
    success: { bg:"#1b2b24", border:"#a6e3a1", hBg:"#a6e3a122", c:"#a6e3a1" },
    error:   { bg:"#2a1a1c", border:"#f38ba8", hBg:"#f38ba822", c:"#f38ba8" },
    warn:    { bg:"#2a2310", border:"#f9e2af", hBg:"#f9e2af22", c:"#f9e2af" },
    info:    { bg:"#1e1e2e", border:"#cba6f7", hBg:"#cba6f722", c:"#cba6f7" },
    user:    { bg:"#1a1a2e", border:"#f9e2af", hBg:"#f9e2af22", c:"#f9e2af" },
    ai:      { bg:"#1a2a1a", border:"#94e2d5", hBg:"#94e2d522", c:"#94e2d5" },
    // background tab types
    dom:     { bg:"#1e2a1e", border:"#74c7ec", hBg:"#74c7ec22", c:"#74c7ec" },
    inject:  { bg:"#1e1e2e", border:"#fab387", hBg:"#fab38722", c:"#fab387" },
    exec:    { bg:"#2a1e2a", border:"#cba6f7", hBg:"#cba6f722", c:"#cba6f7" },
    queue:   { bg:"#1e2a2a", border:"#89dceb", hBg:"#89dceb22", c:"#89dceb" },
    push:    { bg:"#2a2a1e", border:"#f2cdcd", hBg:"#f2cdcd22", c:"#f2cdcd" },
    mcp:     { bg:"#1e2028", border:"#89b4fa", hBg:"#89b4fa22", c:"#89b4fa" },
    // tool tab types
    hit:     { bg:"#1e1e2e", border:"#89b4fa", hBg:"#89b4fa22", c:"#89b4fa" },
    waiting: { bg:"#2a2310", border:"#f9e2af", hBg:"#f9e2af22", c:"#f9e2af" },
    received:{ bg:"#1b2b24", border:"#a6e3a1", hBg:"#a6e3a122", c:"#a6e3a1" },
  };

  const LLM_STATE_COLORS = {
    generating: "#f38ba8",
    idle:       "#6c7086",
    injectable: "#a6e3a1",
    injecting:  "#89b4fa",
    unknown:    "#6c7086",
  };

  const BTN_STATE_COLORS = {
    active:    "#a6e3a1",
    disabled:  "#f9e2af",
    not_found: "#f38ba8",
    unknown:   "#6c7086",
  };

  // The "All" panel log (original)
  function log(type, title, data = {}) {
    _ensurePanel();
    if (!_logCont) return;
    _appendLogEntry(_logCont, type, title, data);
  }

  // Background tab log — everything
  function bgLog(type, title, data = {}) {
    _ensurePanel();
    // Also log to main panel for non-user/ai types
    if (!["user","ai"].includes(type)) {
      // map bg types to main panel
      const mainType = { dom:"info", inject:"info", exec:"info", queue:"info",
                         push:"info", mcp:"request", hit:"request", waiting:"warn",
                         received:"success" }[type] || type;
      log(mainType, title, data);
    }
    if (!_bgLogCont) return;
    _appendLogEntry(_bgLogCont, type, title, data);
  }

  // Tool tab log — only MCP events
  function toolLog(type, title, data = {}) {
    _ensurePanel();
    if (!_toolLogCont) return;
    _appendLogEntry(_toolLogCont, type, title, data);
  }

  function _appendLogEntry(container, type, title, data) {
    const s = TSTYLE[type] || TSTYLE.info;
    const body = Object.keys(data).length ? JSON.stringify(data, null, 2) : null;
    const big = body && body.length > 600;
    const collapsed = big && ["success","request","received","hit"].includes(type);

    const el = document.createElement("div");
    el.dataset.lt = type;
    el.style.cssText = `width:100%;border-radius:6px;background:${s.bg};border:1px solid ${s.border};font-size:11px;overflow:hidden;flex-shrink:0;box-sizing:border-box;`;

    const h = document.createElement("div");
    h.style.cssText = `padding:5px 10px;background:${s.hBg};color:${s.c};font-weight:bold;display:flex;justify-content:space-between;align-items:center;cursor:${collapsed?"pointer":"default"};`;
    h.innerHTML = `<span>${title}${collapsed?' <span style="color:#6c7086;font-size:9px">(expand)</span>':""}</span><span style="color:#6c7086;font-size:10px;">${new Date().toLocaleTimeString()}</span>`;

    el.appendChild(h);

    if (body) {
      const pre = document.createElement("pre");
      pre.style.cssText = `padding:8px 10px;margin:0;white-space:pre-wrap;word-break:break-all;color:#cdd6f4;background:#11111b55;max-height:280px;overflow-y:auto;display:${collapsed?"none":"block"};font-size:11px;box-sizing:border-box;`;
      pre.textContent = body;
      if (collapsed) h.addEventListener("click", () => {
        const show = pre.style.display === "none";
        pre.style.display = show ? "block" : "none";
        const hint = h.querySelector("span span");
        if (hint) hint.textContent = show ? "(collapse)" : "(expand)";
      });
      el.appendChild(pre);
    }

    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  let _panelInited = false;

  function _ensurePanel() {
    if (!_panelInited) initPanel();
  }

  // Toggle button that floats when panel is hidden
  let _toggleBtn = null;

  function _makeToggleBtn() {
    _toggleBtn = document.createElement("button");
    _toggleBtn.id = "vbc-toggle-btn";
    _toggleBtn.textContent = "VC";
    _toggleBtn.title = "Show VibesCode Panel";
    _toggleBtn.style.cssText = [
      "position:fixed", "bottom:20px", "right:20px",
      "width:42px", "height:42px", "border-radius:50%",
      "background:#cba6f7", "color:#1e1e2e",
      "border:2px solid #89b4fa", "cursor:pointer",
      "font-size:11px", "font-weight:bold",
      "font-family:'Consolas','Menlo',monospace",
      "z-index:999998", "display:none",
      "box-shadow:0 4px 16px rgba(0,0,0,.5)",
    ].join(";");
    _toggleBtn.addEventListener("click", () => {
      _isPanelHidden = false;
      _panel.style.display = "flex";
      _toggleBtn.style.display = "none";
      bgLog("info", "👁 Panel shown", {});
    });
    document.body.appendChild(_toggleBtn);
  }

  function initPanel() {
    if (_panelInited) return;
    _panelInited = true;

    if (document.getElementById("vbc-panel")) return;

    _makeToggleBtn();

    _panel = document.createElement("div");
    _panel.id = "vbc-panel";
    _panel.style.cssText = [
      "position:fixed", `top:${_savedPos.top}`, `right:${_savedPos.right}`,
      `width:${_savedPos.width}`, `height:${_savedPos.height}`,
      "min-width:300px", "min-height:200px",
      "background:#1e1e2e", "border:2px solid #313244", "border-radius:12px",
      "box-shadow:0 12px 32px rgba(0,0,0,.6)", "display:flex", "flex-direction:column",
      "font-family:'Consolas','Menlo','Monaco',monospace",
      "z-index:999999", "overflow:hidden", "box-sizing:border-box",
    ].join(";");

    // ── Header ──
    const hdr = document.createElement("div");
    hdr.id = "vbc-hdr";
    hdr.style.cssText = "padding:0 12px;height:44px;background:#11111b;color:#cdd6f4;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;border-bottom:1px solid #313244;flex-shrink:0;";
    hdr.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="color:#f38ba8;font-size:10px;">⬤</span>
        <span style="color:#f9e2af;font-size:10px;">⬤</span>
        <span style="color:#a6e3a1;font-size:10px;">⬤</span>
        <span style="margin-left:4px;color:#a6adc8;font-size:11px;font-weight:bold;">LuckeyVibes</span>
        <span style="font-size:9px;padding:2px 6px;border-radius:10px;background:#313244;color:#cba6f7;margin-left:4px;">${PLATFORM.name}</span>
        <span id="vbc-mcp-badge" style="font-size:9px;padding:2px 6px;border-radius:10px;background:#2a1a3e;color:#89b4fa;margin-left:2px;">v13+</span>
      </div>
      <div style="display:flex;gap:4px;align-items:center;">
        <button id="vbc-history-btn" title="Tool history" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">📋</button>
        <button id="vbc-tools-btn" title="List MCP tools" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">🔧</button>
        <button id="vbc-path-btn" title="Set project path" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">📁</button>
        <button id="vbc-shell-btn" title="Run shell command" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">$_</button>
        <button id="vbc-clear" title="Clear active tab logs" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">🗑</button>
        <button id="vbc-export" title="Export logs" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 9px;font-size:10px;cursor:pointer;">💾</button>
        <button id="vbc-fs" title="Fullscreen" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 9px;font-size:10px;cursor:pointer;font-weight:bold;">🗖</button>
        <button id="vbc-hide" title="Hide panel" style="background:#f38ba822;color:#f38ba8;border:1px solid #f38ba855;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;font-weight:bold;">✕</button>
      </div>`;

    // ── Status bar ──
    const statusBar = document.createElement("div");
    statusBar.style.cssText = "padding:4px 12px;background:#11111b;border-bottom:1px solid #1e1e2e;font-size:10px;color:#6c7086;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;gap:8px;";
    statusBar.innerHTML = `
      <span id="vbc-status">⏳ Connecting…</span>
      <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">
        <span id="vbc-llm-state" style="font-size:9px;padding:1px 5px;border-radius:8px;background:#313244;color:#6c7086;">LLM: unknown</span>
        <span id="vbc-btn-state" style="font-size:9px;padding:1px 5px;border-radius:8px;background:#313244;color:#6c7086;">BTN: unknown</span>
        <span id="vbc-calls">🔧 0 calls</span>
      </div>`;

    // ── Quick-input bar ──
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

    // ── Tabs ──
    const tabsBar = document.createElement("div");
    tabsBar.id = "vbc-tabs";
    tabsBar.style.cssText = "display:flex;gap:4px;padding:6px 10px;background:#181825;border-bottom:1px solid #313244;flex-shrink:0;overflow-x:auto;";

    const TABS = [
      ["all",        "All"],
      ["user",       "👤 User"],
      ["ai",         "🤖 AI"],
      ["tool",       "🔧 Tools"],
      ["background", "⚙️ Background"],
    ];

    TABS.forEach(([f, l]) => {
      const b = document.createElement("button");
      b.dataset.tab = f;
      b.textContent = l;
      b.style.cssText = "font-size:10px;padding:3px 8px;border-radius:4px;cursor:pointer;border:1px solid #313244;background:transparent;color:#6c7086;white-space:nowrap;flex-shrink:0;";
      if (f === "all") { b.style.borderColor="#89b4fa"; b.style.background="#89b4fa22"; b.style.color="#89b4fa"; }
      tabsBar.appendChild(b);
    });

    // ── Log containers (one per tab that needs its own) ──
    // Main container = "all", "user", "ai", "tool" (filtered)
    _logCont = document.createElement("div");
    _logCont.id = "vbc-logs-main";
    _logCont.style.cssText = "flex:1;min-height:0;padding:10px;background:#181825;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;";

    // Background container
    _bgLogCont = document.createElement("div");
    _bgLogCont.id = "vbc-logs-bg";
    _bgLogCont.style.cssText = "flex:1;min-height:0;padding:10px;background:#181825;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;display:none;";

    // Tool container
    _toolLogCont = document.createElement("div");
    _toolLogCont.id = "vbc-logs-tool";
    _toolLogCont.style.cssText = "flex:1;min-height:0;padding:10px;background:#181825;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;display:none;";

    _panel.appendChild(hdr);
    _panel.appendChild(statusBar);
    _panel.appendChild(quickBar);
    _panel.appendChild(tabsBar);
    _panel.appendChild(_logCont);
    _panel.appendChild(_bgLogCont);
    _panel.appendChild(_toolLogCont);
    document.body.appendChild(_panel);

    _makeDraggable(_panel, hdr);
    _makeResizable(_panel);

    // ── Tab switching ──
    tabsBar.addEventListener("click", e => {
      const btn = e.target.closest("button[data-tab]");
      if (!btn) return;
      _activeTab = btn.dataset.tab;

      tabsBar.querySelectorAll("button[data-tab]").forEach(b => {
        const active = b === btn;
        b.style.borderColor = active ? "#89b4fa" : "#313244";
        b.style.background  = active ? "#89b4fa22" : "transparent";
        b.style.color       = active ? "#89b4fa" : "#6c7086";
      });

      // Show correct container
      _logCont.style.display    = ["all","user","ai"].includes(_activeTab) ? "flex" : "none";
      _toolLogCont.style.display  = _activeTab === "tool"       ? "flex" : "none";
      _bgLogCont.style.display  = _activeTab === "background"   ? "flex" : "none";

      if (_activeTab === "all") _applyFilter("all");
      else if (_activeTab === "user") _applyFilter("user");
      else if (_activeTab === "ai") _applyFilter("ai");
    });

    // ── Button handlers ──
    document.getElementById("vbc-fs").addEventListener("click", e => { e.stopPropagation(); _toggleFs(); });

    document.getElementById("vbc-hide").addEventListener("click", e => {
      e.stopPropagation();
      _isPanelHidden = true;
      _panel.style.display = "none";
      _toggleBtn.style.display = "flex";
      _toggleBtn.style.alignItems = "center";
      _toggleBtn.style.justifyContent = "center";
    });

    document.getElementById("vbc-clear").addEventListener("click", e => {
      e.stopPropagation();
      if (_activeTab === "background") _bgLogCont.innerHTML = "";
      else if (_activeTab === "tool") _toolLogCont.innerHTML = "";
      else _logCont.innerHTML = "";
    });

    document.getElementById("vbc-export").addEventListener("click", e => { e.stopPropagation(); _export(); });

    document.getElementById("vbc-history-btn").addEventListener("click", e => {
      e.stopPropagation();
      if (TOOL_HISTORY.length === 0) {
        bgLog("info", "📋 No tool history yet", {});
        return;
      }
      const lines = TOOL_HISTORY.map((h, i) =>
        `#${i + 1} [${new Date(h.time).toLocaleTimeString()}] ${h.tool} (${h.duration}ms) ${h.ok ? "✅" : "❌"}\n  ${h.preview}`
      ).join("\n\n");
      bgLog("info", `📋 Last ${TOOL_HISTORY.length} tool calls`, { history: lines });
    });

    document.getElementById("vbc-path-btn").addEventListener("click", e => {
      e.stopPropagation();
      _showQuickBar("Path:", "Paste project path (e.g. C:/Users/user/myapp)", async (val) => {
        if (!val) return;
        const normalizedVal = normalizePath(val);
        bgLog("dom", `📁 Setting root via panel: ${normalizedVal}`, {});
        const result = await McpClient.callTool("detect_root", { hint: normalizedVal });
        bgLog("success", "📁 Root set", { result: result.text });
      });
    });

    document.getElementById("vbc-shell-btn").addEventListener("click", e => {
      e.stopPropagation();
      _showQuickBar("$ Shell:", "Enter shell command…", async (val) => {
        if (!val) return;
        bgLog("exec", `🖥 Shell command from panel: ${val}`, {});
        const result = await McpClient.callTool("shell", { cmd: val });
        bgLog(result.ok ? "success" : "error", `$ ${val}`, { output: result.text });
      });
    });

    document.getElementById("vbc-tools-btn").addEventListener("click", async e => {
      e.stopPropagation();
      try {
        const resp = await fetch(`${MCP_BASE_URL}/tools`);
        const data = await resp.json();
        const lines = (data.tools || []).map(t => `• ${t.name}: ${t.description}`).join("\n");
        bgLog("info", `🔧 ${data.total} tools registered`, { tools: lines });
      } catch (err) {
        bgLog("error", "❌ Could not fetch tools", { error: err.message });
      }
    });

    // Quick bar
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
    if (!_logCont) return;
    _logCont.querySelectorAll("[data-lt]").forEach(el => {
      const t = el.dataset.lt;
      el.style.display = (
        f === "all" ||
        (f === "user" && t === "user") ||
        (f === "ai"   && t === "ai")
      ) ? "" : "none";
    });
  }

  function updateStatus(txt)     { const e = document.getElementById("vbc-status");    if (e) e.textContent = txt; }
  function updateCallCount(n)    { const e = document.getElementById("vbc-calls");     if (e) e.textContent = `🔧 ${n} call${n!==1?"s":""}`; }
  function updateMcpBadge(ready) { const e = document.getElementById("vbc-mcp-badge"); if (e) { e.style.color = ready ? "#a6e3a1" : "#f38ba8"; e.textContent = ready ? "MCP ✓" : "MCP ✗"; } }

  function updateStatusBar(llmState, btnStatus) {
    const llmEl = document.getElementById("vbc-llm-state");
    const btnEl = document.getElementById("vbc-btn-state");
    if (llmEl) { llmEl.textContent = `LLM: ${llmState}`; llmEl.style.color = LLM_STATE_COLORS[llmState] || "#6c7086"; }
    if (btnEl) { btnEl.textContent = `BTN: ${btnStatus}`; btnEl.style.color = BTN_STATE_COLORS[btnStatus] || "#6c7086"; }
  }

  // ── Draggable ──
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
      if (!drag || raf) return;
      raf=requestAnimationFrame(() => {
        raf=null; if (!drag) return;
        const l=Math.max(0,Math.min(sl+e.clientX-sx,innerWidth-el.offsetWidth));
        const t=Math.max(0,Math.min(st+e.clientY-sy,innerHeight-el.offsetHeight));
        el.style.left=l+"px"; el.style.top=t+"px";
      });
    });
    document.addEventListener("mouseup", () => { drag=false; });
  }

  // ── Resizable — 8-direction handles ──
  function _makeResizable(el) {
    const EDGE = 8; // px hitzone
    let resizing = false;
    let dir = "";
    let startX, startY, startW, startH, startL, startT;

    const getCursor = (d) => ({
      n:"ns-resize", s:"ns-resize", e:"ew-resize", w:"ew-resize",
      ne:"nesw-resize", nw:"nwse-resize", se:"nwse-resize", sw:"nesw-resize",
    }[d] || "default");

    el.addEventListener("mousemove", e => {
      if (resizing || _isFs) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const w = r.width, h = r.height;
      const onN = y < EDGE, onS = y > h - EDGE;
      const onW = x < EDGE, onE = x > w - EDGE;
      let d = "";
      if (onN && onW) d="nw"; else if (onN && onE) d="ne";
      else if (onS && onW) d="sw"; else if (onS && onE) d="se";
      else if (onN) d="n"; else if (onS) d="s";
      else if (onW) d="w"; else if (onE) d="e";
      el.style.cursor = d ? getCursor(d) : "";
      dir = d;
    });

    el.addEventListener("mousedown", e => {
      if (!dir || _isFs) return;
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      startX = e.clientX; startY = e.clientY;
      const r = el.getBoundingClientRect();
      startW = r.width; startH = r.height;
      startL = r.left;  startT = r.top;
      el.style.right = "auto";
    });

    document.addEventListener("mousemove", e => {
      if (!resizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const MIN_W = 300, MIN_H = 200;
      if (dir.includes("e")) el.style.width  = Math.max(MIN_W, startW + dx) + "px";
      if (dir.includes("s")) el.style.height = Math.max(MIN_H, startH + dy) + "px";
      if (dir.includes("w")) {
        const nw = Math.max(MIN_W, startW - dx);
        el.style.width = nw + "px";
        el.style.left  = (startL + startW - nw) + "px";
      }
      if (dir.includes("n")) {
        const nh = Math.max(MIN_H, startH - dy);
        el.style.height = nh + "px";
        el.style.top    = (startT + startH - nh) + "px";
      }
    });

    document.addEventListener("mouseup", () => { resizing = false; });
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
    [_logCont, _bgLogCont, _toolLogCont].forEach(cont => {
      if (!cont) return;
      cont.querySelectorAll("[data-lt]").forEach(el => {
        rows.push({
          tab:   cont.id,
          type:  el.dataset.lt,
          title: el.querySelector("span")?.textContent?.trim(),
          data:  (() => { try { return JSON.parse(el.querySelector("pre")?.textContent||"{}"); } catch { return {}; } })(),
          time:  el.querySelector("[style*='font-size:10px']")?.textContent,
        });
      });
    });
    const url = URL.createObjectURL(new Blob([JSON.stringify(rows,null,2)],{type:"application/json"}));
    Object.assign(document.createElement("a"),{href:url,download:`vibescode-${Date.now()}.json`}).click();
    URL.revokeObjectURL(url);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 15. BOOT
  // ══════════════════════════════════════════════════════════════════════════
  initPanel();
  bgLog("info", `🚀 VibesCode v13+ booting`, { platform: PLATFORM.name, host: location.hostname, tab: TAB_ID });

  McpClient.connect();
  connectPushChannel();
  startHeartbeat();

  // Auto root detection on boot
  setTimeout(async () => {
    bgLog("dom", "🔍 Auto-detecting project root from page URL...", { url: location.href });
    try {
      const result = await McpClient.callTool("detect_root", { hint: location.href });
      bgLog("success", "📁 Auto root detection result", { result: result.text });
    } catch (err) {
      bgLog("warn", "⚠️ Auto root detection skipped", { reason: err.message });
    }
  }, 3000);

  // Debounced MutationObserver
  setTimeout(() => {
    const root = getChatRoot();
    let SCAN_TIMER = null;
    new MutationObserver(() => {
      clearTimeout(SCAN_TIMER);
      SCAN_TIMER = setTimeout(() => {
        scanUserMessages();
        scanAiMessages();
      }, 250);
    }).observe(root, { childList: true, subtree: true, characterData: true });
    bgLog("dom", "👁 DOM MutationObserver attached", { rootTag: root.tagName || root.nodeName });
  }, 800);

  // SPA navigation reset
  let _lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== _lastPath) {
      _lastPath = location.pathname;
      _seenTexts.clear();
      bgLog("info", "🔄 SPA navigation detected", { path: location.pathname });
    }
  }, 1_000);

  console.log("[VibesCode v13+] Loaded |", PLATFORM.name, "| MCP:", MCP_BASE_URL, "| Tab:", TAB_ID);
})();