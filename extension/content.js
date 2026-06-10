// content.js — VibesCode Agent v9
// ════════════════════════════════════════════════════════════════════════════
// Industry-standard rewrite
//   • MCP communication via official JSON-RPC 2.0 over SSE (no hand-parsing)
//   • Server→Extension push channel for Django-initiated messages
//   • Zero duplicate message deduplication with WeakSet + text fingerprints
//   • Single MutationObserver; platform-aware selectors
//   • All AI output parsed by the extension itself — no injection of AGENT_CALL
//     markers into the chat input; instead we intercept the AI's tool-call
//     output via MutationObserver and forward it straight to MCP.
// ════════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  // ══════════════════════════════════════════════════════════════════════════
  // 0. CONFIG — edit MCP_BASE_URL to match your server
  // ══════════════════════════════════════════════════════════════════════════

  // The MCP server base URL.  If running standalone: http://localhost:8001
  // If mounted inside Django at /mcp/: https://your-domain.com
  const MCP_BASE_URL  = "https://studentassignment.lyralogics.com";
  // When MCP runs standalone (port 8001): MCP_BASE_URL = "http://localhost:8001"
  //   → /sse, /messages, /push/stream are at the root
  // When MCP is mounted inside Django at /mcp/:
  //   MCP_BASE_URL = "https://your-django-domain.com" and paths below stay correct
  const MCP_SSE_URL   = `${MCP_BASE_URL}/mcp/sse`;           // FastMCP SSE handshake
  const MCP_POST_URL  = `${MCP_BASE_URL}/mcp/messages`;      // FastMCP JSON-RPC POST
  const PUSH_SSE_URL  = `${MCP_BASE_URL}/push/stream`;   // Django push channel

  // ══════════════════════════════════════════════════════════════════════════
  // 1. PLATFORM SELECTORS
  // ══════════════════════════════════════════════════════════════════════════
  const PLATFORMS = [
    {
      name:     "ChatGPT",
      match:    h => h.includes("chatgpt.com") || h.includes("chat.openai.com"),
      userMsg:  '[data-message-author-role="user"] .whitespace-pre-wrap',
      aiMsg:    '[data-message-author-role="assistant"] .markdown',
      input:    '#prompt-textarea',
      sendBtn:  '[data-testid="send-button"]:not([disabled])',
      chatRoot: 'main',
    },
    {
      name:     "Claude",
      match:    h => h.includes("claude.ai"),
      userMsg:  '[data-testid="user-message"]',
      aiMsg:    '[data-testid="assistant-message"] .whitespace-pre-wrap',
      input:    'div[contenteditable="true"]',
      sendBtn:  'button[aria-label="Send message"]:not([disabled])',
      chatRoot: '[data-testid="conversation-turn-list"]',
    },
    {
      name:     "Gemini",
      match:    h => h.includes("gemini.google.com"),
      userMsg:  'user-query .query-text',
      aiMsg:    'model-response .markdown',
      input:    'rich-textarea div[contenteditable="true"]',
      sendBtn:  'button.send-button:not([disabled])',
      chatRoot: 'chat-history',
    },
    {
      name:     "Perplexity",
      match:    h => h.includes("perplexity.ai"),
      userMsg:  '[data-testid="user-message"]',
      aiMsg:    '.prose',
      input:    'textarea',
      sendBtn:  'button[aria-label="Submit"]:not([disabled])',
      chatRoot: 'main',
    },
    {
      name:     "Generic",
      match:    () => true,
      userMsg:  '.user-message, .human-turn, [class*="user-turn"]',
      aiMsg:    '.assistant-message, .bot-message, [class*="assistant-turn"]',
      input:    'div[contenteditable="true"], textarea',
      sendBtn:  'button[type="submit"]:not([disabled])',
      chatRoot: 'main, body',
    },
  ];

  const PLATFORM = PLATFORMS.find(p => p.match(location.hostname));
  console.log("[VibesCode v9] Platform:", PLATFORM.name);

  // ══════════════════════════════════════════════════════════════════════════
  // 2. DOM HELPERS
  // ══════════════════════════════════════════════════════════════════════════
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };

  const getInput   = () => $(PLATFORM.input) || $('div[contenteditable="true"]') || $('textarea');
  const getSendBtn = () => $(PLATFORM.sendBtn)
    || $('button[aria-label="Send message"]:not([disabled])')
    || $('[data-testid="send-button"]:not([disabled])');
  const getChatRoot = () => $(PLATFORM.chatRoot) || $('main') || document.body;
  const isBotTyping = () => !!(
    $('button[aria-label="Stop response"]') ||
    $('[data-testid="stop-button"]') ||
    $('.stop-button')
  );

  // ══════════════════════════════════════════════════════════════════════════
  // 3. INJECT TEXT INTO AI INPUT BOX AND OPTIONALLY SUBMIT
  // ══════════════════════════════════════════════════════════════════════════
  async function typeIntoInput(text, submit = true) {
    // Wait if bot is still generating
    await waitUntil(() => !isBotTyping(), 30_000);

    const input = getInput();
    if (!input) {
      log("error", "⚠️ No input box found", { platform: PLATFORM.name });
      return;
    }
    input.focus();

    if (input.tagName === "TEXTAREA") {
      // React-controlled textarea — must trigger synthetic event
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      )?.set;
      if (nativeSetter) nativeSetter.call(input, text);
      else input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // contenteditable div — execCommand keeps React/Vue state in sync
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand("insertText", false, text);
      if (!ok) {
        input.innerText = text;
        input.dispatchEvent(new InputEvent("input", {
          bubbles: true, data: text, inputType: "insertText",
        }));
      }
    }

    if (!submit) return;

    // Wait for the send button to become available
    const btn = await waitForElement(
      () => getSendBtn(),
      8_000
    );
    if (btn) {
      btn.click();
      log("info", "📨 Submitted to AI", { chars: text.length });
    } else {
      // Fallback: Enter key
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13,
        which: 13, bubbles: true, cancelable: true,
      }));
      log("info", "📨 Submitted via Enter key (button timeout)");
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. MCP CLIENT  (JSON-RPC 2.0 over SSE, official protocol)
  //
  //    Lifecycle:
  //      A. GET  /mcp/sse         → SSE stream; server sends "endpoint" event
  //                                  with the POST URL for this session
  //      B. POST {session_post_url} → send initialize + tools/list RPC calls
  //      C. SSE "message" events  → server responses arrive here
  //
  //    Tool calls:
  //      We send  tools/call  JSON-RPC requests;
  //      responses arrive as SSE "message" events with the matching id.
  // ══════════════════════════════════════════════════════════════════════════
  const McpClient = (() => {
    let _sessionPostUrl = null;      // set when SSE "endpoint" event arrives
    let _pendingCalls   = new Map(); // rpc_id → {resolve, reject}
    let _nextId         = 1;
    let _initialized    = false;
    let _sseSource      = null;

    // ── Connect ──────────────────────────────────────────────────────────────
    function connect() {
      log("info", "🔌 Connecting to MCP", { url: MCP_SSE_URL });
      _sseSource = new EventSource(MCP_SSE_URL);

      // "endpoint" event carries the session-specific POST URL
      _sseSource.addEventListener("endpoint", async (e) => {
        // e.data may be a relative path or full URL
        const raw = e.data.trim();
        // raw is a URL-encoded path like /messages/?session_id=abc123
        // or an absolute URL. Normalise to absolute.
        if (raw.startsWith("http")) {
          _sessionPostUrl = raw;
        } else {
          // Strip the standalone server's own origin if present, re-base on MCP_BASE_URL
          _sessionPostUrl = MCP_BASE_URL.replace(/\/$/, "") + raw;
        }
        log("info", "📡 MCP session endpoint", { url: _sessionPostUrl });
        await _initialize();
      });

      // "message" events carry JSON-RPC responses
      _sseSource.addEventListener("message", (e) => {
        let msg;
        try { msg = JSON.parse(e.data); }
        catch {
          log("error", "⚠️ MCP message parse error", { raw: e.data });
          return;
        }
        _handleRpcResponse(msg);
      });

      _sseSource.onerror = (err) => {
        log("error", "❌ MCP SSE error — reconnecting in 5 s", {});
        _sseSource.close();
        _initialized = false;
        _sessionPostUrl = null;
        setTimeout(connect, 5_000);
      };
    }

    // ── JSON-RPC transport layer ──────────────────────────────────────────────
    async function _send(method, params = {}) {
      if (!_sessionPostUrl) throw new Error("MCP not connected");
      const id  = _nextId++;
      const rpc = { jsonrpc: "2.0", id, method, params };

      // Each call returns a promise that resolves when the response arrives
      return new Promise((resolve, reject) => {
        _pendingCalls.set(id, { resolve, reject });
        fetch(_sessionPostUrl, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(rpc),
        }).catch(err => {
          _pendingCalls.delete(id);
          reject(err);
        });
      });
    }

    function _handleRpcResponse(msg) {
      const pending = _pendingCalls.get(msg.id);
      if (!pending) return;
      _pendingCalls.delete(msg.id);

      if (msg.error) {
        pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }

    // ── Handshake ─────────────────────────────────────────────────────────────
async function _initialize() {
  try {

    await _send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "vibescode-extension",
        version: "9.0.0",
      },
    });

    _initialized = true;

    updateStatus("✅ MCP Ready");

    log("success", "✅ MCP initialized", {
      server: MCP_BASE_URL,
    });

  } catch (err) {

    log("error", "❌ MCP initialize failed", {
      error: err.message,
    });

  }
}

    // ── Public API ────────────────────────────────────────────────────────────
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

    function isReady() { return _initialized; }

    return { connect, callTool, isReady };
  })();


  // ══════════════════════════════════════════════════════════════════════════
  // 5. AI OUTPUT SCANNER — detects tool-call blocks in the AI's responses
  //
  //    The AI is prompted to emit:
  //
  //      AGENT_CALL {"op":"cat","path":"views.py"}
  //
  //    (one line, no fences, compact JSON — impossible to misparse)
  //
  //    The scanner:
  //      1. Reads new AI message nodes (deduplicated by WeakSet)
  //      2. Finds AGENT_CALL lines with a simple startsWith check
  //      3. JSON.parse() the rest of the line — if it throws, skip
  //      4. Maps op → MCP tool name
  //      5. Calls McpClient.callTool()
  //      6. Injects result back into the chat input and submits
  // ══════════════════════════════════════════════════════════════════════════
  const OP_TO_TOOL = {
    // reads
    cat:      "cat",      read: "cat",   read_file: "cat",
    tree:     "tree",
    dir:      "dir",      ls: "dir",
    search:   "search",   grep: "search",
    // writes
    write:    "write",    write_file: "write",
    patch:    "patch",    edit: "patch",
    mkdir:    "mkdir",
    delete:   "delete",   rm: "delete",
    // diagnostics
    shell:    "shell",    run: "shell",
    pytest:   "pytest",
    django_check: "django_check", check: "django_check",
    git_status:   "git_status",   status: "git_status",
    git_diff:     "git_diff",     diff: "git_diff",
    git_log:      "git_log",      log: "git_log",
    flake8:       "flake8",       lint: "flake8",
  };

  const _seenNodes = new WeakSet();
  const _seenTexts = new Set();
  const _processed = new Set();   // fingerprints of handled calls
  let   _busy      = false;
  let   _callCount = 0;

  function scanAiMessages() {
    $$(PLATFORM.aiMsg).forEach(el => {
      if (_seenNodes.has(el)) return;

      const text = (el.innerText || "").trim();
      if (!text || text.length < 4) return;

      const fp = "a:" + text;
      if (_seenTexts.has(fp)) return;

      _seenNodes.add(el);
      _seenTexts.add(fp);

      // Log AI message to terminal
      log("ai", "🤖 AI", { message: text.length > 300 ? text.slice(0, 300) + "…" : text });

      // Look for AGENT_CALL lines
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("AGENT_CALL")) continue;

        // Everything after "AGENT_CALL" (and optional colon/space) is JSON
        const jsonPart = trimmed.replace(/^AGENT_CALL\s*:?\s*/, "");
        let call;
        try { call = JSON.parse(jsonPart); }
        catch {
          log("error", "⚠️ AGENT_CALL parse error", { line: trimmed });
          continue;
        }

        const callFp = JSON.stringify(call);
        if (_processed.has(callFp)) continue;
        _processed.add(callFp);

        scheduleToolCall(call);
        break; // one call per AI message (MCP is sequential)
      }
    });
  }

  function scanUserMessages() {
    $$(PLATFORM.userMsg).forEach(el => {
      if (_seenNodes.has(el)) return;
      const text = (el.innerText || "").trim();
      if (!text || text.length < 2) return;
      const fp = "u:" + text;
      if (_seenTexts.has(fp)) return;
      _seenNodes.add(el);
      _seenTexts.add(fp);
      log("user", "👤 You", { message: text });
    });
  }

  async function scheduleToolCall(call) {
    if (_busy) {
      // Re-queue after brief wait (handles rapid consecutive calls)
      await sleep(800);
      scheduleToolCall(call);
      return;
    }
    _busy = true;
    updateStatus(`🔧 ${call.op || call.name}`);

    const toolName = OP_TO_TOOL[call.op] || call.op || call.name;
    // Build args — strip op/name, pass the rest
    const { op, name: _n, ...args } = call;

    let result;
    try {
      result = await McpClient.callTool(toolName, args);
    } catch (err) {
      result = { ok: false, text: err.message };
    }

    _callCount++;
    updateCallCount(_callCount);
    updateStatus("✅ Done");

    // Inject result into AI chat
    const reply =
      `__TOOL_RESULT__\nop: ${toolName}\n` +
      (result.ok
        ? result.text.slice(0, 6000)   // cap to avoid token overflow
        : `ERROR: ${result.text}`) +
      `\n__END_RESULT__\n\nContinue based on the result above.`;

    await typeIntoInput(reply, true);
    _busy = false;
  }


  // ══════════════════════════════════════════════════════════════════════════
  // 6. SERVER → EXTENSION PUSH CHANNEL
  //
  //    Connects to GET /mcp/push/stream (EventSource)
  //    On "inject" events: types the message into the AI input and submits.
  //    This lets Django push arbitrary messages into the AI conversation.
  //
  //    Example from Django:
  //        from project_agent.mcp.server import push_to_extension
  //        push_to_extension("Run pytest and fix any failures.")
  // ══════════════════════════════════════════════════════════════════════════
  function connectPushChannel() {
    log("info", "📥 Connecting to push channel", { url: PUSH_SSE_URL });
    const es = new EventSource(PUSH_SSE_URL);

    es.addEventListener("inject", async (e) => {
      let payload;
      try { payload = JSON.parse(e.data); }
      catch { payload = { text: e.data, submit: true }; }

      const text   = payload.text   ?? "";
      const submit = payload.submit ?? true;

      if (!text) return;
      log("info", "📥 Push received", { text: text.slice(0, 80), submit });
      await typeIntoInput(text, submit);
    });

    es.onerror = () => {
      log("error", "❌ Push channel error — reconnecting in 8 s", {});
      es.close();
      setTimeout(connectPushChannel, 8_000);
    };
  }


  // ══════════════════════════════════════════════════════════════════════════
  // 7. UTILITIES
  // ══════════════════════════════════════════════════════════════════════════
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function waitUntil(predicate, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (predicate()) return resolve();
        if (Date.now() - start > timeoutMs) return resolve(); // give up, proceed
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  function waitForElement(getter, timeoutMs = 8_000) {
    return new Promise(resolve => {
      const start = Date.now();
      const tick = () => {
        const el = getter();
        if (el) return resolve(el);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. TERMINAL PANEL (unchanged from v8, trimmed)
  // ══════════════════════════════════════════════════════════════════════════
  let _panel       = null;
  let _logCont     = null;
  let _filter      = "all";
  let _isFs        = false;
  let _savedPos    = { top:"20px", right:"20px", left:"auto", width:"440px", height:"560px" };

  const TSTYLE = {
    request: { bg:"#1e1e2e", border:"#89b4fa", hBg:"#89b4fa22", c:"#89b4fa" },
    success: { bg:"#1b2b24", border:"#a6e3a1", hBg:"#a6e3a122", c:"#a6e3a1" },
    error:   { bg:"#2a1a1c", border:"#f38ba8", hBg:"#f38ba822", c:"#f38ba8" },
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
        <span id="vbc-mcp-badge" style="font-size:9px;padding:2px 6px;border-radius:10px;background:#2a1a3e;color:#89b4fa;margin-left:2px;">MCP</span>
      </div>
      <div style="display:flex;gap:4px;align-items:center;">
        <button id="vbc-clear" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">🗑</button>
        <button id="vbc-export" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;">💾</button>
        <button id="vbc-fs" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:3px 9px;font-size:10px;cursor:pointer;font-weight:bold;">🗖</button>
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
        (f === "tool" && ["request","success","error"].includes(t))
      ) ? "" : "none";
    });
  }

  function updateStatus(txt) { const e = document.getElementById("vbc-status"); if (e) e.textContent = txt; }
  function updateCallCount(n) { const e = document.getElementById("vbc-calls"); if (e) e.textContent = `🔧 ${n} call${n!==1?"s":""}`; }

  function log(type, title, data = {}) {
    initPanel();
    const s = TSTYLE[type] || TSTYLE.info;
    const big = JSON.stringify(data).length > 600;
    const collapsed = big && ["success","request"].includes(type);

    const el = document.createElement("div");
    el.dataset.lt = type;
    el.style.cssText = `width:100%;border-radius:6px;background:${s.bg};border:1px solid ${s.border};font-size:11px;overflow:hidden;flex-shrink:0;`;

    const h = document.createElement("div");
    h.style.cssText = `padding:5px 10px;background:${s.hBg};color:${s.c};font-weight:bold;display:flex;justify-content:space-between;align-items:center;cursor:${collapsed?"pointer":"default"};`;
    h.innerHTML = `<span>${title}${collapsed?' <span style="color:#6c7086;font-size:9px">(expand)</span>':""}</span><span style="color:#6c7086;font-size:10px;">${new Date().toLocaleTimeString()}</span>`;

    const pre = document.createElement("pre");
    pre.style.cssText = `padding:8px 10px;margin:0;white-space:pre-wrap;word-break:break-all;color:#cdd6f4;background:#11111b55;max-height:280px;overflow-y:auto;display:${collapsed?"none":"block"};font-size:11px;`;
    pre.textContent = JSON.stringify(data, null, 2);

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
      rows.push({ type:el.dataset.lt, title:el.querySelector("span")?.textContent?.trim(), data: (() => { try { return JSON.parse(el.querySelector("pre")?.textContent||"{}"); } catch { return {}; } })(), time:el.querySelector("[style*='font-size:10px']")?.textContent });
    });
    const url=URL.createObjectURL(new Blob([JSON.stringify(rows,null,2)],{type:"application/json"}));
    Object.assign(document.createElement("a"),{href:url,download:`vibescode-${Date.now()}.json`}).click();
    URL.revokeObjectURL(url);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 9. BOOT
  // ══════════════════════════════════════════════════════════════════════════
  initPanel();
  log("info", "🚀 VibesCode v9 (MCP)", { platform: PLATFORM.name, host: location.hostname });

  // Connect MCP client
  McpClient.connect();

  // Connect push channel (server → extension → AI)
  connectPushChannel();

  // Start message observer after DOM settles
  setTimeout(() => {
    const root = getChatRoot();
    new MutationObserver(() => {
      scanUserMessages();
      scanAiMessages();
    }).observe(root, { childList: true, subtree: true, characterData: true });

    log("info", "👁 Watching DOM", { root: root.tagName });
  }, 800);

  // SPA navigation reset
  let _lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== _lastPath) {
      _lastPath = location.pathname;
      _seenTexts.clear();
      // Note: WeakSet auto-GCs; processed fingerprints stay to avoid re-runs
      log("info", "🔄 SPA navigation", { path: location.pathname });
    }
  }, 1_000);

  console.log("[VibesCode v9] Loaded |", PLATFORM.name, "| MCP:", MCP_BASE_URL);
})();