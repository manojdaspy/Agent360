// content.js — VibesCode Agent v14
// ════════════════════════════════════════════════════════════════════════════
//  ① AI_REQ_RES — single source of truth for every conversation event
//  ② Per-TURN scanner (Gemini / ChatGPT / Claude DOM) — not joined history
//  ③ injectGate() — discard stale MCP results before inject
//  ④ State machine: IDLE→CALL_DETECTED→MCP_EXECUTING→INJECTING→WAITING_AI→IDLE
//  ⑤ Push inject gate (idle + empty input only)
//  ⑥ isBotTyping 700ms settle window (Gemini stop-btn flicker)
//  ⑦ Prose+AGENT_CALL validator — AGENT_PATCH blocks allowed for patch
//  ⑧ AGENT_CALL parse → JSON → repair → field recovery; AGENT_PATCH for edits
//  ⑨ Trace + Inject panel tabs
// ════════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  // ══════════════════════════════════════════════════════════════════════════
  // TRUSTED TYPES POLICY — unique name to avoid conflict with host pages
  // ══════════════════════════════════════════════════════════════════════════
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
      window.trustedTypes.createPolicy("luckeyvibespolicy", {
        createHTML:      s => s,
        createScript:    s => s,
        createScriptURL: s => s,
      });
    } catch (e) {
      // Policy already registered (e.g. extension reloaded in same context)
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 0. CONFIG
  // ══════════════════════════════════════════════════════════════════════════
  // const MCP_BASE_URL   = "https://studentassignment.lyralogics.com";
  const MCP_BASE_URL   = "http://localhost:8000";
  const MCP_SSE_URL    = `${MCP_BASE_URL}/mcp/sse`;
  const PUSH_SSE_URL   = `${MCP_BASE_URL}/push/stream`;
  const PUSH_ACK_URL   = `${MCP_BASE_URL}/push/ack`;
  const HEARTBEAT_URL  = `${MCP_BASE_URL}/ext/heartbeat`;

  const TAB_ID                = Math.random().toString(36).slice(2, 10);
  const HEARTBEAT_INTERVAL_MS = 2000;
  const TOOL_CALL_TIMEOUT_MS    = 30_000;
  const BOT_TYPING_SETTLE_MS    = 700;
  const CHUNK_SIZE              = 4000;
  const MAX_REQ_RES             = 500;

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
      chatRoot: '#thread, main',
      aiTurn:   'section[data-turn="assistant"]',
      userTurn: 'section[data-turn="user"]',
      aiText:   '.markdown',
      sendKeys: [{ key: "Enter", code: "Enter", keyCode: 13 }],
      typingSelectors: [
        'button[aria-label="Stop generating"]',
        'button[data-testid="stop-button"]',
        '[data-testid="stop-button"]',
      ],
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
      chatRoot: '[data-autoscroll-container], main',
      aiTurn:   '[data-is-streaming="false"], [data-is-streaming]',
      userTurn: '[data-testid="user-message"]',
      aiText:   '.standard-markdown, .font-claude-response-body',
      sendKeys: [{ key: "Enter", code: "Enter", keyCode: 13 }],
      typingSelectors: [
        '[data-is-streaming="true"]',
        'button[aria-label="Stop response"]',
      ],
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
      chatRoot: 'infinite-scroller.chat-history, [data-test-id="chat-history-container"], infinite-scroller',
      turnContainer: 'div.conversation-container',
      aiTurn:   'model-response',
      userTurn: 'user-query',
      aiText:   '.markdown, .markdown-main-panel',
      userText: '.query-text, .query-text-line, user-query-content .query-text',
      sendKeys: [
        { key: "Enter", code: "Enter", keyCode: 13, ctrlKey: false },
        { key: "Enter", code: "Enter", keyCode: 13, ctrlKey: true },
      ],
      typingSelectors: [
        '.stop-button',
        '[aria-label="Stop"]',
        'loading-indicator:not([hidden])',
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
      typingSelectors: [
        'button[aria-label="Stop responding"]',
        '.stop-button',
      ],
    },
    {
      name:    "Copilot",
      match:   h => h.includes("copilot.microsoft.com"),
      userMsg: '[data-content="user-message"]',
      aiMsg:   '[data-content="ai-message"] span.font-ligatures-none',
      input:   'div[contenteditable="true"]',
      sendBtns: [
        'button[aria-label="Submit"]:not([disabled])',
        'button[aria-label="Send"]:not([disabled])',
        'button[type="submit"]:not([disabled])',
      ],
      sendBtnAny: [
        'button[aria-label="Submit"]',
        'button[aria-label="Send"]',
        'button[type="submit"]',
      ],
      chatRoot: '[data-content="conversation"]',
      aiTurn:   '[data-content="ai-message"]',
      userTurn: '[data-content="user-message"]',
      aiText:   'span.font-ligatures-none',
      sendKeys: [{ key: "Enter", code: "Enter", keyCode: 13 }],
      typingSelectors: [
        '.processing-state-visible[aria-busy="true"]',
        '.loading-indicator-container:not([hidden])',
      ],
    },
    {
      name:    "DeepSeek",
      match:   h => h.includes("chat.deepseek.com"),
      userMsg: '.ds-message._63c77b1 .fbb737a4',
      aiMsg:   '.ds-markdown.ds-assistant-message-main-content',
      input:   'textarea._27c9245',
      sendBtns: [
        '[role="button"]._52c986b:not(.ds-button--disabled):has(path[d^="M8.3125"])',
      ],
      sendBtnAny: [
        '[role="button"]._52c986b:has(path[d^="M8.3125"])',
      ],
      chatRoot: '.ds-virtual-list.ds-virtual-list--printable',
      aiTurn:   '._4f9bf79',
      userTurn: '._9663006',
      aiText:   '.ds-markdown.ds-assistant-message-main-content',
      sendKeys: [{ key: "Enter", code: "Enter", keyCode: 13 }],
      typingSelectors: [
        '[role="button"]._52c986b:not(.ds-button--disabled) path[d^="M2 4.88"]',
      ],
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
// 0b. PNA-SAFE FETCH — routes through background service worker
//     so localhost is reachable from public-origin content scripts
// ══════════════════════════════════════════════════════════════════════════
function bgFetch(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "FETCH", url, method, headers, body: body ?? null },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (response?.error) {
          return reject(new Error(response.error));
        }
        // Mimic enough of the fetch Response API that callers work unchanged
        resolve({
          ok:     response.ok,
          status: response.status,
          text:   () => Promise.resolve(response.body),
          json:   () => Promise.resolve(JSON.parse(response.body)),
        });
      }
    );
  });
}

// ══════════════════════════════════════════════════════════════════════════
// 0c. PNA-SAFE EventSource — proxied through background service worker
// ══════════════════════════════════════════════════════════════════════════
function bgSSE(url, { eventNames = ["message"], onOpen, onError, onEvent } = {}) {
  const port = chrome.runtime.connect({ name: "SSE_PROXY" });

  port.postMessage({ type: "OPEN", url, eventNames });

  port.onMessage.addListener((msg) => {
    if (msg.type === "open"  && onOpen)  onOpen();
    if (msg.type === "error" && onError) onError();
    if (msg.type === "event" && onEvent) onEvent(msg.name, msg.data);
  });

  port.onDisconnect.addListener(() => {
    if (onError) onError();
  });

  // Return a close handle so callers can shut it down
  return { close: () => port.disconnect() };
}
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
  // TRACEABLE IDs — time-based, human-readable request/response chains
  //   input-20250611121923045123   user message
  //   resp-20250611121923051234    AI response / AGENT_CALL
  //   mcpreq-resp-..._1718123456789  MCP request
  //   mcpres-mcpreq-..._1718123456790 MCP response
  // ══════════════════════════════════════════════════════════════════════════
  function makeTimeId(prefix) {
    const ms  = Date.now();
    const sub = String(Math.floor((performance.now() % 1) * 1_000_000)).padStart(6, "0");
    return `${prefix}-${ms}${sub}`;
  }

  function makeMcpReqId(responseId) {
    return `mcpreq-${responseId}_${Date.now()}`;
  }

  function makeMcpResId(mcpReqId) {
    return `mcpres-${mcpReqId}_${Date.now()}`;
  }

  /** Minimal JSON repair for common LLM mistakes (before strict parse / field recovery). */
  function repairAgentCallJson(raw) {
    let s = raw.trim();
    s = s.replace(/,\s*([}\]])/g, "$1");
    s = s.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"');
    s = s.replace(/\[\s*'([^'\\]*(?:\\.[^'\\]*)*)'\s*\]/g, '["$1"]');
    s = s.replace(/'\s*,\s*'/g, '", "');
    return s;
  }

  /**
   * Aider/Cline-style patch block — no JSON quoting needed for code edits.
   * AGENT_PATCH path=src/app.tsx
   * <<<<<<< SEARCH
   * old lines
   * =======
   * new lines
   * >>>>>>> REPLACE
   */
  function parseAgentPatchBlock(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("AGENT_PATCH")) return null;
    const m = trimmed.match(
      /^AGENT_PATCH\s+path=(\S+)\s*\n<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE\s*$/
    );
    if (!m) return null;
    return {
      op: "patch",
      path: m[1],
      old_str: m[2],
      new_str: m[3],
    };
  }

  /** Normalise Windows path backslashes before JSON.parse. */
  function preprocessAgentCallJson(jsonPart) {
    return jsonPart
      .replace(/\\\\/g, "/")
      .replace(/\\(?!["\\/bfnrtu])/g, "/");
  }

  const AGENT_CALL_FIELD_ORDER = [
    "op", "path", "hint", "cwd", "cmd", "pattern", "extensions",
    "old_str", "new_str", "content", "start_line", "end_line",
    "staged", "n", "timeout", "action", "name", "tag",
  ];

  const BOUNDED_STRING_FIELDS = new Set(["old_str", "new_str", "content"]);

  function unescapeJsonFragment(s) {
    return s
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  function matchSimpleStringField(raw, key) {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const m = raw.match(re);
    return m ? unescapeJsonFragment(m[1]) : undefined;
  }

  function matchScalarField(raw, key) {
    const re = new RegExp(`"${key}"\\s*:\\s*(true|false|-?\\d+(?:\\.\\d+)?)`);
    const m = raw.match(re);
    if (!m) return undefined;
    if (m[1] === "true") return true;
    if (m[1] === "false") return false;
    const n = Number(m[1]);
    return Number.isNaN(n) ? undefined : n;
  }

  /**
   * Extract string fields that may contain raw (unescaped) double quotes.
   * Uses the next JSON key position as the end boundary, then strips one structural closing quote.
   */
  function extractBoundedStringField(raw, key) {
    const marker = `"${key}":"`;
    const keyPos = raw.indexOf(`"${key}"`);
    if (keyPos < 0) return undefined;

    const start = raw.indexOf(marker, keyPos);
    if (start < 0) return undefined;
    const valueStart = start + marker.length;

    let nextKeyPos = raw.length;
    for (const fk of AGENT_CALL_FIELD_ORDER) {
      if (fk === key) continue;
      const fkPos = raw.indexOf(`"${fk}"`, valueStart);
      if (fkPos >= valueStart && fkPos < nextKeyPos) nextKeyPos = fkPos;
    }

    let between = raw.slice(valueStart, nextKeyPos);
    if (between.endsWith('",')) between = between.slice(0, -2);
    else if (between.endsWith('"}')) between = between.slice(0, -2);
    else if (between.endsWith('"')) between = between.slice(0, -1);
    return unescapeJsonFragment(between);
  }

  /**
   * Field-boundary recovery when JSON.parse fails (unescaped quotes in old_str/new_str/content).
   * Uses known key order: reads until next `","<key>":"` delimiter.
   */
  function extractAgentCallFields(raw) {
    const op = matchSimpleStringField(raw, "op");
    if (!op) return null;

    const result = { op };

    for (const key of ["path", "hint", "cwd", "cmd", "pattern", "extensions", "action", "name", "tag"]) {
      if (!raw.includes(`"${key}"`)) continue;
      if (BOUNDED_STRING_FIELDS.has(key)) continue;
      const v = matchSimpleStringField(raw, key);
      if (v !== undefined) result[key] = v;
    }

    for (const key of ["start_line", "end_line", "n", "timeout"]) {
      const v = matchScalarField(raw, key);
      if (v !== undefined) result[key] = v;
    }

    if (raw.includes('"staged"')) {
      const staged = matchScalarField(raw, "staged");
      if (staged !== undefined) result.staged = staged;
    }

    for (const key of BOUNDED_STRING_FIELDS) {
      if (!raw.includes(`"${key}"`)) continue;
      const v = extractBoundedStringField(raw, key);
      if (v !== undefined) result[key] = v;
    }

    return result;
  }

  /**
   * Parse AGENT_CALL JSON — strict JSON first, then field-boundary recovery.
   * @returns {{ call: object|null, method: 'json'|'recover'|'failed', error?: string }}
   */
  function parseAgentCall(jsonPart) {
    const trimmed = jsonPart.trim();
    const prepped = preprocessAgentCallJson(trimmed);

    try {
      return { call: JSON.parse(prepped), method: "json" };
    } catch (e) {
      /* fall through */
    }

    const repaired = repairAgentCallJson(prepped);
    if (repaired !== prepped) {
      try {
        return { call: JSON.parse(repaired), method: "repair" };
      } catch (e) {
        /* fall through */
      }
    }

    const recovered = extractAgentCallFields(trimmed);
    if (recovered?.op) {
      return { call: recovered, method: "recover" };
    }

    return { call: null, method: "failed", error: "unparseable" };
  }

  function formatToolResultHeader(toolName, mcpReqId, mcpResId) {
    return [
      "__TOOL_RESULT__",
      `id: ${mcpResId}`,
      `req_id: ${mcpReqId}`,
      `op: ${toolName}`,
    ].join("\n");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AI_REQ_RES — single source of truth
  // ══════════════════════════════════════════════════════════════════════════
  const AI_REQ_RES = Object.create(null);
  const AI_REQ_RES_ORDER = [];

  function reqResPut(entry) {
    AI_REQ_RES[entry.id] = { ...entry, timestamp: entry.timestamp || Date.now() };
    if (!AI_REQ_RES_ORDER.includes(entry.id)) AI_REQ_RES_ORDER.push(entry.id);
    while (AI_REQ_RES_ORDER.length > MAX_REQ_RES) {
      const old = AI_REQ_RES_ORDER.shift();
      delete AI_REQ_RES[old];
    }
    updateTracePanel();
  }

  function reqResUpdate(id, patch) {
    if (!AI_REQ_RES[id]) return;
    Object.assign(AI_REQ_RES[id], patch);
    updateTracePanel();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATE MACHINE
  // ══════════════════════════════════════════════════════════════════════════
  const SM = {
    IDLE:           "IDLE",
    CALL_DETECTED:  "CALL_DETECTED",
    MCP_EXECUTING:  "MCP_EXECUTING",
    INJECTING:      "INJECTING",
    WAITING_AI:     "WAITING_AI",
  };
  let _state = SM.IDLE;

  function setState(next) {
    _state = next;
    const el = document.getElementById("vbc-sm-state");
    if (el) { el.textContent = `SM: ${next}`; el.style.color = next === SM.IDLE ? "#a6e3a1" : "#89b4fa"; }
  }

  function canScan() {
    return _state === SM.IDLE || _state === SM.WAITING_AI;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TURN REGISTRY — per DOM turn, not global dedup
  // ══════════════════════════════════════════════════════════════════════════
  const _domIdMap     = new WeakMap();
  const _turnState    = new WeakMap();
  const _seenHumanIds = new Set();
  let   _lastHumanId  = null;

  function getDomId(el, prefix = "turn") {
    if (!el) return makeTimeId(prefix);
    if (_domIdMap.has(el)) return _domIdMap.get(el);
    const fromDom =
      el.id ||
      el.getAttribute("data-turn-id") ||
      el.getAttribute("data-message-id") ||
      el.getAttribute("data-turn-id-container") ||
      null;
    const id = fromDom || makeTimeId(prefix);
    _domIdMap.set(el, id);
    return id;
  }

  function getHumanTurnInfos() {
    const out = [];

    if (PLATFORM.name === "Gemini" && PLATFORM.turnContainer) {
      const containers = $$(PLATFORM.turnContainer, document);
      if (containers.length) {
        for (const c of containers) {
          const user = $(PLATFORM.userTurn, c);
          if (!user) continue;
          const textEl = $(PLATFORM.userText || ".query-text", user) || $(".query-text-line", user) || user;
          const text = (textEl.innerText || "").trim();
          if (!text.length) continue;
          const domId = getDomId(c, "human");
          out.push({ el: user, container: c, domId, humanId: `human-${domId}`, text });
        }
        return out;
      }
    }

    if (PLATFORM.name === "ChatGPT" && PLATFORM.userTurn) {
      for (const sec of $$(PLATFORM.userTurn, document)) {
        const textEl = $(".whitespace-pre-wrap", sec) || $('[data-message-author-role="user"]', sec) || sec;
        const text = (textEl.innerText || "").trim();
        if (!text.length) continue;
        const domId = getDomId(sec, "human");
        out.push({ el: sec, container: sec, domId, humanId: `human-${domId}`, text });
      }
      return out;
    }

    if (PLATFORM.name === "Claude" && PLATFORM.userTurn) {
      for (const msg of $$(PLATFORM.userTurn, document)) {
        const text = (msg.innerText || "").trim();
        if (!text.length) continue;
        const container = msg.closest(".group") || msg;
        const domId = getDomId(container, "human");
        out.push({ el: msg, container, domId, humanId: `human-${domId}`, text });
      }
      return out;
    }

    if (PLATFORM.name === "DeepSeek" && PLATFORM.userTurn) {
      for (const container of $$(PLATFORM.userTurn, document)) {
        const textEl = $(PLATFORM.userMsg.split(" ").slice(1).join(" "), container) || container;
        const text = (textEl.innerText || "").trim();
        if (!text.length) continue;
        const domId = getDomId(container, "human");
        out.push({ el: textEl, container, domId, humanId: `human-${domId}`, text });
      }
      return out;
    }

    for (const el of $$(PLATFORM.userMsg, document)) {
      const text = (el.innerText || "").trim();
      if (!text.length) continue;
      const domId = getDomId(el, "human");
      out.push({ el, container: el, domId, humanId: `human-${domId}`, text });
    }
    return out;
  }

  function getAiTurnInfos() {
    const root = getScanRoot().el;
    const out = [];

    if (PLATFORM.name === "Gemini" && PLATFORM.turnContainer) {
      const containers = $$(PLATFORM.turnContainer, document);
      if (containers.length) {
        for (const c of containers) {
          const ai = $(PLATFORM.aiTurn, c);
          if (!ai) continue;
          const textEl = $(PLATFORM.aiText, ai) || ai;
          const text = (textEl.innerText || "").trim();
          if (!text.length) continue;
          const domId = getDomId(c, "turn");
          out.push({ el: ai, container: c, domId, respId: `resp-${domId}`, text, textEl });
        }
        return out;
      }
    }

    if (PLATFORM.name === "ChatGPT" && PLATFORM.aiTurn) {
      for (const sec of $$(PLATFORM.aiTurn, document)) {
        const textEl = $(PLATFORM.aiText, sec) || $(".markdown", sec) || sec;
        const text = (textEl.innerText || "").trim();
        if (text.length < 2) continue;
        const domId = getDomId(sec, "turn");
        out.push({ el: sec, container: sec, domId, respId: `resp-${domId}`, text, textEl });
      }
      return out;
    }

    if (PLATFORM.name === "Claude" && PLATFORM.aiTurn) {
      const seen = new WeakSet();
      for (const block of $$(".font-claude-response.relative, [data-is-streaming]", document)) {
        if (seen.has(block)) continue;
        const textEl = $(PLATFORM.aiText, block) || block;
        const text = (textEl.innerText || "").trim();
        if (text.length < 2) continue;
        seen.add(block);
        const domId = getDomId(block, "turn");
        out.push({ el: block, container: block, domId, respId: `resp-${domId}`, text, textEl });
      }
      return out;
    }

    if (PLATFORM.name === "DeepSeek" && PLATFORM.aiTurn) {
      for (const block of $$(PLATFORM.aiTurn, document)) {
        const textEl = $(PLATFORM.aiText, block) || block;
        const text = (textEl.innerText || "").trim();
        if (text.length < 2) continue;
        const domId = getDomId(block, "turn");
        out.push({ el: block, container: block, domId, respId: `resp-${domId}`, text, textEl });
      }
      return out;
    }

    for (const el of $$(PLATFORM.aiMsg, document)) {
      const text = (el.innerText || "").trim();
      if (!text.length) continue;
      const domId = getDomId(el, "turn");
      out.push({ el, container: el, domId, respId: `resp-${domId}`, text, textEl: el });
    }
    return out;
  }

  function getLastAiTurnId() {
    const turns = getAiTurnInfos();
    return turns.length ? turns[turns.length - 1].respId : null;
  }

  function getLatestUnprocessedAiTurn() {
    const turns = getAiTurnInfos();
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      const st = _turnState.get(t.el);
      if (!st || !st.processed) return t;
    }
    return null;
  }

  function validateAgentCallMessage(text) {
    const patchCall = parseAgentPatchBlock(text);
    if (patchCall) {
      return { ok: true, format: "patch_block", call: patchCall };
    }

    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const agentLines = lines.filter(l => l.startsWith("AGENT_CALL"));
    if (!agentLines.length) return { ok: false, reason: "no_call" };
    if (agentLines.length > 1) return { ok: false, reason: "multiple_calls" };
    return { ok: true, format: "json_line", line: agentLines[0] };
  }

  function injectGate(mcpResEntry) {
    const lastTurnId = getLastAiTurnId();
    if (lastTurnId && mcpResEntry.parent_resp_id && mcpResEntry.parent_resp_id !== lastTurnId) {
      return { allow: false, reason: "stale — AI moved to new turn" };
    }
    if (isBotTyping()) {
      return { allow: false, reason: "bot typing" };
    }
    if (!isInputEmpty()) {
      return { allow: false, reason: "input not empty" };
    }
    const newerPending = TOOL_QUEUE.some(q => q.responseId === mcpResEntry.parent_resp_id);
    if (newerPending) {
      return { allow: false, reason: "newer mcp_req pending for same turn" };
    }
    return { allow: true, reason: "ok" };
  }

  function pushInjectGate() {
    if (_state !== SM.IDLE) return { allow: false, reason: `state=${_state}` };
    if (isBotTyping()) return { allow: false, reason: "bot typing" };
    if (!isInputEmpty()) return { allow: false, reason: "input not empty" };
    return { allow: true, reason: "ok" };
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

  let _scanRootSel = "body";

  function getScanRoot() {
    const candidates = [
      ...(PLATFORM.chatRoot || "").split(",").map(s => s.trim()),
      "infinite-scroller.chat-history",
      "[data-test-id='chat-history-container']",
      "infinite-scroller",
      "#thread",
      "main",
      "body",
    ].filter(Boolean);
    const seen = new Set();
    for (const sel of candidates) {
      if (seen.has(sel)) continue;
      seen.add(sel);
      const el = $(sel);
      if (el) {
        _scanRootSel = sel;
        return { el, sel };
      }
    }
    _scanRootSel = "body";
    return { el: document.body, sel: "body" };
  }

  const getChatRoot = () => getScanRoot().el;

  function probeSelectors() {
    const probes = {
      chat_root: _scanRootSel,
      turn_container: PLATFORM.turnContainer ? $$(PLATFORM.turnContainer, document).length : 0,
      user_turn: PLATFORM.userTurn ? $$(PLATFORM.userTurn, document).length : 0,
      ai_turn: PLATFORM.aiTurn ? $$(PLATFORM.aiTurn, document).length : 0,
      ai_text: PLATFORM.aiText ? $$(PLATFORM.aiText, document).length : 0,
      user_msg_fallback: $$(PLATFORM.userMsg, document).length,
      ai_msg_fallback: $$(PLATFORM.aiMsg, document).length,
      input: !!getInput(),
      send_btn: getSendButtonStatus(),
      bot_typing: isBotTypingRaw(),
      input_empty: isInputEmpty(),
      llm_state: deriveLlmState(),
      sm_state: _state,
      mcp_ready: McpClient.isReady(),
      humans_found: getHumanTurnInfos().length,
      ai_found: getAiTurnInfos().length,
      last_human_id: _lastHumanId,
      last_ai_turn: getLastAiTurnId(),
    };
    return probes;
  }

  function runDomDiagnostics(label = "DOM Diagnostics") {
    const probes = probeSelectors();
    const missing = [];
    if (!probes.turn_container && PLATFORM.turnContainer) missing.push(`turn_container (${PLATFORM.turnContainer})`);
    if (!probes.user_turn && !probes.user_msg_fallback) missing.push(`user_turn (${PLATFORM.userTurn || PLATFORM.userMsg})`);
    if (!probes.ai_turn && !probes.ai_msg_fallback) missing.push(`ai_turn (${PLATFORM.aiTurn || PLATFORM.aiMsg})`);
    if (!probes.input) missing.push(`input (${PLATFORM.input})`);
    if (probes.send_btn === "not_found") missing.push("send_button");
    log("info", `🩺 ${label}`, { ...probes, missing: missing.length ? missing : "none" });
    bgLog("dom", `🩺 ${label}`, { ...probes, missing: missing.length ? missing : "none" });
    return probes;
  }

  function runScanCycle(source = "scan") {
    scanUserMessages();
    scanAiMessages();
    if (source === "poll") return;
  }

  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
  };

  let _lastTypingAt = 0;
  let _wasTyping    = false;

function isBotTypingRaw() {
    // Platform-specific checks first — exact, fast, authoritative when present.
    if (PLATFORM.typingSelectors) {
      for (const sel of PLATFORM.typingSelectors) {
        if ($(sel)) return true;
      }
    }

    // Generic fallback — covers platforms without typingSelectors.
    return !!(
      $('button[aria-label="Stop response"]') ||
      $('button[aria-label="Stop generating"]') ||
      $('[data-testid="stop-button"]') ||
      $('.stop-button') ||
      $('[aria-label="Stop"]') ||
      $('[data-is-streaming="true"]') ||
      $('button[data-testid="stop-button"]') ||
      $('button[aria-label="Stop responding"]') ||
      $('loading-indicator:not([hidden])') ||
      $('.loading-indicator-container:not([hidden])') ||
      $('.processing-state-visible[aria-busy="true"]')
    );
  }

  function isBotTyping() {
    const now = Date.now();
    const typing = isBotTypingRaw();
    if (typing) {
      _wasTyping = true;
      _lastTypingAt = now;
      return true;
    }
    if (_wasTyping && now - _lastTypingAt < BOT_TYPING_SETTLE_MS) return true;
    _wasTyping = false;
    return false;
  }

  const isInputEmpty = () => {
    const input = getInput();
    if (!input) return true;
    const val = input.isContentEditable ? (input.innerText || "").trim() : (input.value || "").trim();
    return val.length === 0;
  };

  const deriveLlmState = () => {
    if (_state === SM.INJECTING || _busy) return "injecting";
    if (_state === SM.MCP_EXECUTING) return "injecting";
    if (isBotTyping()) return "generating";
    const btnStatus = getSendButtonStatus();
    const empty = isInputEmpty();
    if (empty) return "injectable";
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

      _sseSource = bgSSE(MCP_SSE_URL, {
        eventNames: ["endpoint", "message"],
        onOpen: () => {
          _backoffMs = 1000;
          bgLog("mcp", "🟢 MCP SSE connection opened", {});
        },
        onError: () => {
          bgLog("error", `❌ MCP SSE error — reconnecting in ${_backoffMs}ms`, {});
          _sseSource.close();
          _initialized    = false;
          _sessionPostUrl = null;
          updateMcpBadge(false);
          setTimeout(() => { _backoffMs = Math.min(_backoffMs * 2, 30_000); connect(); }, _backoffMs);
        },
        onEvent: (name, data) => {
          if (name === "endpoint") {
            const raw = data.trim();
            _sessionPostUrl = raw.startsWith("http")
              ? raw
              : MCP_BASE_URL.replace(/\/$/, "") + raw;
            bgLog("mcp", "📡 MCP session endpoint received", { url: _sessionPostUrl });
            _initialize();
          }
          if (name === "message") {
            let msg;
            try { msg = JSON.parse(data); }
            catch { bgLog("error", "⚠️ MCP parse error", { raw: data }); return; }
            _handleRpcResponse(msg);
          }
        },
      });
    }

    async function _send(method, params = {}) {
      if (!_sessionPostUrl) throw new Error("MCP not connected");
      const id  = _nextId++;
      const rpc = { jsonrpc: "2.0", id, method, params };
      return new Promise((resolve, reject) => {
        _pendingCalls.set(id, { resolve, reject });
        bgFetch(_sessionPostUrl, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(rpc),
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

    async function callTool(name, args = {}, mcpReqId = "") {
      if (!_initialized) throw new Error("MCP not ready");

      const reqId = mcpReqId || makeMcpReqId("unknown");

      toolLog("hit", `📡 HIT MCP: ${name}`, { id: reqId, args });
      bgLog("mcp", `📤 Calling MCP tool: ${name}`, { id: reqId, args });

      toolLog("waiting", `⏳ WAITING for MCP: ${name}`, { id: reqId });
      bgLog("mcp", `⌛ Waiting for MCP result: ${name}...`, { id: reqId });

      const result = await Promise.race([
        _send("tools/call", { name, arguments: args }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Tool call timed out after ${TOOL_CALL_TIMEOUT_MS / 1000}s`)), TOOL_CALL_TIMEOUT_MS)
        ),
      ]);

      const mcpResId = makeMcpResId(reqId);
      const text = result?.content?.[0]?.text ?? JSON.stringify(result);
      const ok   = !result?.isError;

      if (ok) {
        toolLog("received", `✅ RECEIVED from MCP: ${name}`, { id: mcpResId, req_id: reqId, chars: text.length, preview: text.slice(0, 200) });
        bgLog("success", `✅ MCP result received: ${name}`, { id: mcpResId, req_id: reqId, chars: text.length, preview: text.slice(0, 300) });
      } else {
        toolLog("error", `❌ MCP ERROR: ${name}`, { id: mcpResId, req_id: reqId, error: text });
        bgLog("error", `❌ MCP tool error: ${name}`, { id: mcpResId, req_id: reqId, error: text });
      }

      return { ok, text, raw: result, mcpReqId: reqId, mcpResId };
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
        await bgFetch(HEARTBEAT_URL, {
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

  let _busy      = false;
  let _callCount = 0;

  function registerAiTurn(turn) {
    if (AI_REQ_RES[turn.respId]) return;
    reqResPut({
      id: turn.respId,
      type: "ai_response",
      parent_id: _lastHumanId,
      turn_dom_id: turn.domId,
      has_call: false,
      status: "detected",
      text_preview: turn.text.slice(0, 200),
    });
    const preview = turn.text.length > 300 ? turn.text.slice(0, 300) + "…" : turn.text;
    log("ai", "🤖 AI turn detected", { id: turn.respId, turn_dom: turn.domId, preview });
    bgLog("ai", "🤖 AI turn detected", { id: turn.respId, turn_dom: turn.domId, preview });
  }

  function scanAiMessages() {
    if (_state === SM.WAITING_AI && isBotTypingRaw()) setState(SM.IDLE);
    if (!canScan()) return;
    if (isBotTyping()) return;

    for (const turn of getAiTurnInfos()) registerAiTurn(turn);

    const turn = getLatestUnprocessedAiTurn();
    if (!turn) return;

    const prev = _turnState.get(turn.el) || {};
    if (prev.processed) return;
    if (prev.status === "executing" || prev.status === "queued") return;

    const validation = validateAgentCallMessage(turn.text);
    if (!validation.ok) {
      const status = validation.reason === "no_call" ? "no_call" : "skipped";
      reqResUpdate(turn.respId, { status, skip_reason: validation.reason, has_call: false });
      _turnState.set(turn.el, { processed: true, status });
      if (validation.reason === "no_call") {
        log("ai", "🤖 AI turn (no AGENT_CALL)", { id: turn.respId, preview: turn.text.slice(0, 120) });
      } else {
        log("skip", `⏭️ AI turn skipped: ${validation.reason}`, { id: turn.respId, reason: validation.reason });
        bgLog("warn", `⏭️ AI turn skipped: ${validation.reason}`, { id: turn.respId, reason: validation.reason });
      }
      return;
    }

    bgLog("dom", "🔍 Tool call in latest AI turn", {
      id: turn.respId,
      format: validation.format,
      raw: (validation.line || turn.text).slice(0, 120),
    });

    let call = null;
    let parseMethod = validation.format;

    if (validation.format === "patch_block") {
      call = validation.call;
    } else {
      const jsonPart = validation.line.replace(/^AGENT_CALL\s*:?\s*/, "");
      const parsed = parseAgentCall(jsonPart);
      if (!parsed.call) {
        reqResUpdate(turn.respId, { status: "error", skip_reason: "parse_error", has_call: true });
        _turnState.set(turn.el, { processed: true, status: "parse_error" });
        log("error", "❌ AGENT_CALL unparseable — turn skipped", { id: turn.respId, line: validation.line.slice(0, 200) });
        bgLog("error", "❌ AGENT_CALL unparseable — turn skipped", { id: turn.respId, line: validation.line.slice(0, 200) });
        return;
      }
      call = parsed.call;
      parseMethod = parsed.method;
    }

    if (parseMethod === "recover" || parseMethod === "repair") {
      log("success", `✅ AGENT_CALL recovered (${call.op}) via ${parseMethod}`, { id: turn.respId, op: call.op });
      bgLog("success", `✅ AGENT_CALL recovered via ${parseMethod}`, { id: turn.respId, op: call.op, method: parseMethod });
    } else if (parseMethod === "patch_block") {
      log("success", `✅ AGENT_PATCH block parsed (${call.path})`, { id: turn.respId, op: "patch" });
      bgLog("success", "✅ AGENT_PATCH block parsed", { id: turn.respId, path: call.path });
    }

    const normalizedCall = normalizeCallPaths(call);
    const mcpReqId = makeMcpReqId(turn.respId);

    reqResUpdate(turn.respId, {
      has_call: true,
      op: normalizedCall.op,
      status: "queued",
      mcp_req_id: mcpReqId,
    });
    const { op: _callOp, name: _callName, ...mcpArgs } = normalizedCall;
    reqResPut({
      id: mcpReqId,
      type: "mcp_req",
      parent_resp_id: turn.respId,
      tool: OP_TO_TOOL[normalizedCall.op] || normalizedCall.op,
      args: mcpArgs,
      status: "queued",
    });

    _turnState.set(turn.el, { processed: false, status: "queued", mcp_req_id: mcpReqId });
    setState(SM.CALL_DETECTED);
    bgLog("dom", `📬 Queuing: ${normalizedCall.op}`, { id: turn.respId, mcp_req_id: mcpReqId, call: normalizedCall });
    enqueueToolCall(normalizedCall, turn.respId, mcpReqId, turn.el);
  }

  function scanUserMessages() {
    for (const human of getHumanTurnInfos()) {
      if (_seenHumanIds.has(human.humanId)) continue;
      _seenHumanIds.add(human.humanId);
      _lastHumanId = human.humanId;
      reqResPut({
        id: human.humanId,
        type: "human",
        turn_dom_id: human.domId,
        text_preview: human.text.slice(0, 200),
        status: "detected",
      });
      const msg = human.text.length > 200 ? human.text.slice(0, 200) + "…" : human.text;
      log("user", "👤 User turn detected", { id: human.humanId, turn_dom: human.domId, message: msg });
      bgLog("user", "👤 User turn detected", { id: human.humanId, turn_dom: human.domId, message: msg });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 11. TOOL QUEUE
  // ══════════════════════════════════════════════════════════════════════════
  const TOOL_QUEUE = [];
  let PROCESSING_QUEUE = false;

  function enqueueToolCall(call, responseId, mcpReqId, turnEl) {
    const item = {
      call,
      responseId: responseId || makeTimeId("resp"),
      mcpReqId: mcpReqId || makeMcpReqId(responseId),
      turnEl,
    };
    TOOL_QUEUE.push(item);
    reqResUpdate(item.mcpReqId, { status: "queued" });
    bgLog("queue", `📥 Enqueued: ${call.op} (depth: ${TOOL_QUEUE.length})`, { id: item.responseId, mcp_req_id: item.mcpReqId });
    processQueue();
  }

  async function processQueue() {
    if (PROCESSING_QUEUE) return;
    PROCESSING_QUEUE = true;
    while (TOOL_QUEUE.length > 0) {
      const item = TOOL_QUEUE.shift();
      bgLog("queue", `▶️ Processing: ${item.call.op} (${TOOL_QUEUE.length} left)`, { id: item.responseId, mcp_req_id: item.mcpReqId });
      try {
        await executeToolCall(item);
      } catch (err) {
        bgLog("error", `❌ Queue error: ${item.call.op}`, { id: item.responseId, error: err.message });
        setState(SM.IDLE);
      }
    }
    PROCESSING_QUEUE = false;
    if (_state !== SM.WAITING_AI) setState(SM.IDLE);
    bgLog("queue", "✅ Queue empty", {});
  }

  async function injectToolResult(item, toolName, result, resultText) {
    const header = formatToolResultHeader(toolName, result.mcpReqId, result.mcpResId);
    const isCatOp = NO_CHUNK_OPS.has(item.call.op);
    const mcpResEntry = {
      id: result.mcpResId,
      parent_resp_id: item.responseId,
      parent_req_id: result.mcpReqId,
    };

    const gate = injectGate(mcpResEntry);
    if (!gate.allow) {
      reqResUpdate(result.mcpResId, { status: "skipped", skip_reason: gate.reason });
      reqResUpdate(item.responseId, { status: "skipped", inject_skip: gate.reason });
      if (item.turnEl) _turnState.set(item.turnEl, { processed: true, status: "skipped" });
      bgLog("warn", `⏭️ Inject skipped: ${gate.reason}`, { id: result.mcpResId, req_id: result.mcpReqId, reason: gate.reason });
      injectLog("skip", `⏭️ Inject skipped: ${gate.reason}`, { id: result.mcpResId, req_id: result.mcpReqId });
      setState(SM.IDLE);
      return false;
    }

    setState(SM.INJECTING);
    _busy = true;

    if (isCatOp) {
      injectLog("inject", `📄 Injecting cat (${resultText.length} chars)`, { id: result.mcpResId, req_id: result.mcpReqId });
      const reply = `${header}\n${resultText}\n__END_RESULT__\n\nContinue based on the result above.`;
      const sent = await typeIntoInput(reply, true);
      if (sent) {
        reqResUpdate(result.mcpResId, { status: "injected" });
        reqResUpdate(item.responseId, { status: "injected" });
        if (item.turnEl) _turnState.set(item.turnEl, { processed: true, status: "done" });
      }
      bgLog(sent ? "success" : "error", sent ? "✅ cat inject done" : "❌ cat inject failed", { id: result.mcpResId, req_id: result.mcpReqId });
      setState(sent ? SM.WAITING_AI : SM.IDLE);
      _busy = false;
      return sent;
    }

    const chunks = chunkText(resultText, CHUNK_SIZE);
    let allSent = true;
    for (let i = 0; i < chunks.length; i++) {
      const g2 = injectGate(mcpResEntry);
      if (!g2.allow) {
        bgLog("warn", `⏭️ Chunk inject aborted: ${g2.reason}`, { id: result.mcpResId });
        allSent = false;
        break;
      }
      const isLast = i === chunks.length - 1;
      const chunkHeader = i === 0 ? `${header}\n` : `[chunk ${i + 1}/${chunks.length}] req_id: ${result.mcpReqId}\n`;
      const footer = isLast ? `\n__END_RESULT__\n\nContinue based on the result above.` : `\n[more chunks follow — wait for __END_RESULT__]`;
      const reply = chunkHeader + chunks[i] + footer;
      injectLog("inject", `📦 Chunk ${i + 1}/${chunks.length}`, { id: result.mcpResId, chars: chunks[i].length });
      const sent = await typeIntoInput(reply, true);
      if (!sent) { allSent = false; break; }
      if (!isLast) await waitUntil(() => !isBotTyping(), 60_000);
    }

    if (allSent) {
      reqResUpdate(result.mcpResId, { status: "injected" });
      reqResUpdate(item.responseId, { status: "injected" });
      if (item.turnEl) _turnState.set(item.turnEl, { processed: true, status: "done" });
    }
    setState(allSent ? SM.WAITING_AI : SM.IDLE);
    _busy = false;
    return allSent;
  }

  async function executeToolCall(item) {
    const { call, responseId, mcpReqId, turnEl } = item;
    setState(SM.MCP_EXECUTING);
    _busy = true;
    updateStatus(`🔧 ${call.op || call.name}`);
    reqResUpdate(mcpReqId, { status: "executing" });
    reqResUpdate(responseId, { status: "executing" });
    if (turnEl) _turnState.set(turnEl, { processed: false, status: "executing", mcp_req_id: mcpReqId });
    bgLog("exec", `🚀 Executing: ${call.op}`, { id: responseId, mcp_req_id: mcpReqId, call });

    const toolName = OP_TO_TOOL[call.op] || call.op || call.name;
    const { op, name: _n, ...args } = call;

    let result;
    const startTime = Date.now();
    try {
      result = await McpClient.callTool(toolName, args, mcpReqId);
    } catch (err) {
      const mcpResId = makeMcpResId(mcpReqId);
      result = { ok: false, text: err.message, mcpReqId, mcpResId };
      bgLog("error", `❌ Tool exception: ${toolName}`, { id: mcpResId, req_id: mcpReqId, error: err.message });
    }

    reqResPut({
      id: result.mcpResId,
      type: "mcp_res",
      parent_req_id: mcpReqId,
      parent_resp_id: responseId,
      ok: result.ok,
      chars: (result.text || "").length,
      status: "received",
      preview: (result.text || "").slice(0, 200),
    });
    reqResUpdate(mcpReqId, { status: "done", mcp_res_id: result.mcpResId });
    reqResUpdate(responseId, { mcp_res_id: result.mcpResId });

    addHistory({
      tool: toolName,
      args,
      ok: result.ok,
      responseId,
      mcpReqId: result.mcpReqId,
      mcpResId: result.mcpResId,
      duration: Date.now() - startTime,
      preview: (result.text || "").slice(0, 200),
    });

    _callCount++;
    updateCallCount(_callCount);

    const resultText = result.ok ? result.text : `ERROR: ${result.text}`;
    await injectToolResult(item, toolName, result, resultText);
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
      es = bgSSE(url, {
        eventNames: ["inject"],
        onOpen: () => {
          backoff = 1000;
          bgLog("mcp", "🟢 Push channel connected", {});
        },
        onError: () => {
          bgLog("warn", "⚠️ Push channel SSE error — reconnecting", {});
          es.close();
          setTimeout(() => { backoff = Math.min(backoff * 2, 30_000); open(); }, backoff);
        },
        onEvent: async (name, data) => {
          if (name !== "inject") return;
          let payload;
          try { payload = JSON.parse(data); }
          catch { payload = { text: data, submit: true }; }
          const text   = payload.text   ?? "";
          const submit = payload.submit ?? true;
          const msgId  = payload.id     ?? null;
          if (!text) return;
          const pushId = msgId || makeTimeId("push");
          reqResPut({ id: pushId, type: "push", text_preview: text.slice(0, 80), submit, status: "queued" });
          bgLog("push", "📥 Push message received", { id: pushId, preview: text.slice(0, 80), submit });

          const gate = pushInjectGate();
          let sent = false;
          if (!gate.allow) {
            reqResUpdate(pushId, { status: "skipped", skip_reason: gate.reason });
            bgLog("warn", `⏭️ Push inject skipped: ${gate.reason}`, { id: pushId, reason: gate.reason });
          } else {
            setState(SM.INJECTING);
            sent = await typeIntoInput(text, submit);
            reqResUpdate(pushId, { status: sent ? "injected" : "error" });
            setState(sent ? SM.WAITING_AI : SM.IDLE);
          }

          try {
            await bgFetch(PUSH_ACK_URL, {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({ tab: TAB_ID, id: msgId || pushId, sent }),
            });
          } catch { }
        },
      });
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
  let _bgLogCont    = null;
  let _toolLogCont  = null;
  let _injectLogCont = null;
  let _traceLogCont  = null;
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
    skip:    { bg:"#2a2310", border:"#f9e2af", hBg:"#f9e2af22", c:"#f9e2af" },
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
    if (["inject", "exec", "queue", "dom"].includes(type)) injectLog(type, title, data);
  }

  // Tool tab log — only MCP events
  function toolLog(type, title, data = {}) {
    _ensurePanel();
    if (!_toolLogCont) return;
    _appendLogEntry(_toolLogCont, type, title, data);
  }

  function injectLog(type, title, data = {}) {
    _ensurePanel();
    if (!_injectLogCont) return;
    _appendLogEntry(_injectLogCont, type, title, data);
  }

  const TRACE_COLORS = {
    human:       "#f9e2af",
    ai_response: "#94e2d5",
    mcp_req:     "#89b4fa",
    mcp_res:     "#a6e3a1",
    push:        "#f2cdcd",
  };

  function updateTracePanel() {
    _ensurePanel();
    if (!_traceLogCont) return;
    _traceLogCont.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const id of AI_REQ_RES_ORDER) {
      const e = AI_REQ_RES[id];
      if (!e) continue;
      const color = TRACE_COLORS[e.type] || "#cba6f7";
      const parents = [e.parent_id, e.parent_resp_id, e.parent_req_id].filter(Boolean).join(" ← ");
      const row = document.createElement("div");
      row.style.cssText = `padding:6px 8px;border-left:3px solid ${color};background:#11111b55;border-radius:4px;font-size:10px;margin-bottom:4px;`;
      row.innerHTML = `<div style="color:${color};font-weight:bold;">${e.type} · ${e.status || "?"}</div>
        <div style="color:#6c7086;font-size:9px;">${id}</div>
        ${parents ? `<div style="color:#45475a;font-size:9px;">↳ ${parents}</div>` : ""}
        ${e.op ? `<div style="color:#cdd6f4;">op: ${e.op}</div>` : ""}
        ${e.skip_reason ? `<div style="color:#f38ba8;">skip: ${e.skip_reason}</div>` : ""}
        ${e.text_preview ? `<div style="color:#6c7086;margin-top:2px;">${e.text_preview.slice(0, 80)}…</div>` : ""}`;
      frag.appendChild(row);
    }
    _traceLogCont.appendChild(frag);
    _traceLogCont.scrollTop = _traceLogCont.scrollHeight;
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
        <span id="vbc-mcp-badge" style="font-size:9px;padding:2px 6px;border-radius:10px;background:#2a1a3e;color:#89b4fa;margin-left:2px;">v14.1</span>
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
        <span id="vbc-sm-state" style="font-size:9px;padding:1px 5px;border-radius:8px;background:#313244;color:#a6e3a1;">SM: IDLE</span>
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
      ["inject",     "💉 Inject"],
      ["trace",      "📊 Trace"],
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

    _injectLogCont = document.createElement("div");
    _injectLogCont.id = "vbc-logs-inject";
    _injectLogCont.style.cssText = "flex:1;min-height:0;padding:10px;background:#181825;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;display:none;";

    _traceLogCont = document.createElement("div");
    _traceLogCont.id = "vbc-logs-trace";
    _traceLogCont.style.cssText = "flex:1;min-height:0;padding:10px;background:#181825;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;display:none;";

    _panel.appendChild(hdr);
    _panel.appendChild(statusBar);
    _panel.appendChild(quickBar);
    _panel.appendChild(tabsBar);
    _panel.appendChild(_logCont);
    _panel.appendChild(_bgLogCont);
    _panel.appendChild(_toolLogCont);
    _panel.appendChild(_injectLogCont);
    _panel.appendChild(_traceLogCont);
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
      _logCont.style.display       = ["all","user","ai"].includes(_activeTab) ? "flex" : "none";
      _toolLogCont.style.display   = _activeTab === "tool"       ? "flex" : "none";
      _injectLogCont.style.display = _activeTab === "inject"     ? "flex" : "none";
      _traceLogCont.style.display  = _activeTab === "trace"      ? "flex" : "none";
      _bgLogCont.style.display     = _activeTab === "background" ? "flex" : "none";

      if (_activeTab === "trace") updateTracePanel();
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
      else if (_activeTab === "inject") _injectLogCont.innerHTML = "";
      else if (_activeTab === "trace") { for (const k of Object.keys(AI_REQ_RES)) delete AI_REQ_RES[k]; AI_REQ_RES_ORDER.length = 0; updateTracePanel(); }
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
        `#${i + 1} [${new Date(h.time).toLocaleTimeString()}] ${h.tool} (${h.duration}ms) ${h.ok ? "✅" : "❌"}\n  resp: ${h.responseId || "?"}\n  req:  ${h.mcpReqId || "?"}\n  res:  ${h.mcpResId || "?"}\n  ${h.preview}`
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
        const resp = await bgFetch(`${MCP_BASE_URL}/tools`);
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
    const rows = AI_REQ_RES_ORDER.map(id => ({ source: "AI_REQ_RES", ...AI_REQ_RES[id] }));
    [_logCont, _bgLogCont, _toolLogCont, _injectLogCont].forEach(cont => {
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
  bgLog("info", `🚀 VibesCode v14 booting`, { platform: PLATFORM.name, host: location.hostname, tab: TAB_ID });
  setState(SM.IDLE);

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

  // Boot diagnostics + scanner
  function attachScanner() {
    const { el, sel } = getScanRoot();
    let SCAN_TIMER = null;
    const mo = new MutationObserver(() => {
      clearTimeout(SCAN_TIMER);
      SCAN_TIMER = setTimeout(() => runScanCycle("mutation"), 250);
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    if (el !== document.body) {
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    bgLog("dom", "👁 MutationObserver attached", { root: sel, tag: el.tagName || el.nodeName });
    log("info", "👁 Scanner ready", { observe: sel, platform: PLATFORM.name });
    runDomDiagnostics("Boot DOM check");
    runScanCycle("boot");
  }

  setTimeout(attachScanner, 800);
  setTimeout(() => { runDomDiagnostics("Delayed DOM check (2s)"); runScanCycle("delayed"); }, 2000);
  setTimeout(() => { runDomDiagnostics("Delayed DOM check (5s)"); runScanCycle("delayed"); }, 5000);

  // Poll fallback — catches turns if observer misses (SPA / lazy render)
  setInterval(() => {
    if (canScan() && !isBotTyping()) runScanCycle("poll");
  }, 1500);

  // SPA navigation reset
  let _lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== _lastPath) {
      _lastPath = location.pathname;
      _seenHumanIds.clear();
      bgLog("info", "🔄 SPA navigation detected", { path: location.pathname });
    }
  }, 1_000);

  console.log("[VibesCode v14] Loaded |", PLATFORM.name, "| MCP:", MCP_BASE_URL, "| Tab:", TAB_ID);
})();