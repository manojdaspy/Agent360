// content.js
// Intercepts __AGENT_CALL__ markers and logs to a fully scrollable, draggable, expandable console panel

(function () {
  "use strict";

  const SCAN_INTERVAL = 800;
  const processedCalls = new Set();

  let terminalPanel = null;
  let logContainer = null;
  let isFullScreen = false;

  // Cache coordinates to restore positions safely after minimizing
  let savedPosition = {
    top: "20px",
    left: "auto",
    right: "20px",
    width: "420px",
    height: "550px"
  };

  // ── 1. Create Draggable/Expandable/Scrollable Floating Terminal ────────────

  function initializeTerminal() {
    if (document.getElementById("vibescode-floating-terminal")) return;

    // Main Panel Window
    terminalPanel = document.createElement("div");
    terminalPanel.id = "vibescode-floating-terminal";
    terminalPanel.style.cssText = `
      position: fixed;
      top: ${savedPosition.top};
      right: ${savedPosition.right};
      width: ${savedPosition.width};
      height: ${savedPosition.height};
      background: #1e1e2e;
      border: 2px solid #313244;
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.5);
      display: flex;
      flex-direction: column;
      font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
      z-index: 999999;
      overflow: hidden !important; /* Protect panel edge leakage */
      box-sizing: border-box;
      transition: all 0.15s ease-in-out;
    `;

    // Header Handle Bar
    const header = document.createElement("div");
    header.id = "vibescode-terminal-header";
    header.style.cssText = `
      padding: 12px 14px;
      background: #11111b;
      color: #cdd6f4;
      font-size: 12px;
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: move;
      user-select: none;
      border-bottom: 1px solid #313244;
      height: 42px;
      box-sizing: border-box;
    `;
    header.innerHTML = `
      <div style="display:flex; align-items:center; gap:6px;">
        <span style="color:#f38ba8;">⬤</span>
        <span style="color:#f9e2af;">⬤</span>
        <span style="color:#a6e3a1;">⬤</span>
        <span style="margin-left:6px; color:#a6adc8;">VibesCode Live Console</span>
      </div>
      <button id="vibescode-fullscreen-btn" style="
        background: #313244;
        color: #cdd6f4;
        border: none;
        border-radius: 4px;
        padding: 4px 10px;
        font-family: sans-serif;
        font-size: 11px;
        cursor: pointer;
        font-weight: bold;
      ">🗖 Maximize</button>
    `;

    // Inner Log Area (CRITICAL HEIGHT & SCROLL FIXES HERE)
    logContainer = document.createElement("div");
    logContainer.id = "vibescode-log-container";
    logContainer.style.cssText = `
      width: 100%;
      height: calc(100% - 42px); /* Forces explicit bounded container size */
      padding: 12px;
      background: #181825;
      overflow-y: auto !important; /* Activates native vertical scrolling */
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-sizing: border-box;
    `;

    terminalPanel.appendChild(header);
    terminalPanel.appendChild(logContainer);
    document.body.appendChild(terminalPanel);

    // Wire Up Listeners
    makeElementDraggable(terminalPanel, header);
    document.getElementById("vibescode-fullscreen-btn").addEventListener("click", toggleFullScreen);
  }

  // ── 2. Full Screen State Toggle ────────────────────────────────────────────

  function toggleFullScreen(e) {
    e.stopPropagation();
    const btn = document.getElementById("vibescode-fullscreen-btn");

    if (!isFullScreen) {
      // Record current layout states before expanding
      savedPosition.top = terminalPanel.style.top || "20px";
      savedPosition.left = terminalPanel.style.left || "auto";
      savedPosition.right = terminalPanel.style.right || "20px";
      savedPosition.width = terminalPanel.style.width || "420px";
      savedPosition.height = terminalPanel.style.height || "550px";

      // Snap layout to full viewport frame
      terminalPanel.style.top = "0px";
      terminalPanel.style.left = "0px";
      terminalPanel.style.right = "0px";
      terminalPanel.style.width = "100vw";
      terminalPanel.style.height = "100vh";
      terminalPanel.style.borderRadius = "0px";

      btn.textContent = "🗗 Minimize";
      document.getElementById("vibescode-terminal-header").style.cursor = "default";
      isFullScreen = true;
    } else {
      // Revert back to original custom offsets
      terminalPanel.style.top = savedPosition.top;
      terminalPanel.style.left = savedPosition.left;
      terminalPanel.style.right = savedPosition.right;
      terminalPanel.style.width = savedPosition.width;
      terminalPanel.style.height = savedPosition.height;
      terminalPanel.style.borderRadius = "12px";

      btn.textContent = "🗖 Maximize";
      document.getElementById("vibescode-terminal-header").style.cursor = "move";
      isFullScreen = false;
    }
    
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  // ── 3. Drag Logic ──────────────────────────────────────────────────────────

  function makeElementDraggable(el, handle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    handle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
      if (isFullScreen) return;
      if (e.target.id === "vibescode-fullscreen-btn") return;
      
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
      e.preventDefault();
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      
      let newTop = el.offsetTop - pos2;
      let newLeft = el.offsetLeft - pos1;

      if (newTop < 0) newTop = 0;
      if (newLeft < 0) newLeft = 0;
      if (newTop + el.offsetHeight > window.innerHeight) newTop = window.innerHeight - el.offsetHeight;
      if (newLeft + el.offsetWidth > window.innerWidth) newLeft = window.innerWidth - el.offsetWidth;

      el.style.top = newTop + "px";
      el.style.left = newLeft + "px";
      el.style.right = "auto"; 
    }

    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
    }
  }

  // ── 4. Append Logs ─────────────────────────────────────────────────────────

  function logToTerminal(type, title, dataPayload) {
    initializeTerminal();

    const logEntry = document.createElement("div");
    logEntry.style.cssText = `
      width: 100%;
      border-radius: 6px;
      background: ${type === 'error' ? '#2a1a1c' : type === 'request' ? '#1e1e2e' : '#1b2b24'};
      border: 1px solid ${type === 'error' ? '#f38ba8' : type === 'request' ? '#89b4fa' : '#a6e3a1'};
      font-size: 11px;
      overflow: hidden;
      flex-shrink: 0; /* Critical: Stops list crowding and guarantees scrollbar mechanics */
    `;

    const entryHeader = document.createElement("div");
    entryHeader.style.cssText = `
      padding: 6px 10px;
      background: ${type === 'error' ? '#f38ba822' : type === 'request' ? '#89b4fa22' : '#a6e3a122'};
      color: ${type === 'error' ? '#f38ba8' : type === 'request' ? '#89b4fa' : '#a6e3a1'};
      font-weight: bold;
      display: flex;
      justify-content: space-between;
    `;
    entryHeader.innerHTML = `
      <span>${title}</span>
      <span style="color:#6c7086;">${new Date().toLocaleTimeString()}</span>
    `;

    const entryBody = document.createElement("pre");
    entryBody.style.cssText = `
      padding: 10px;
      margin: 0;
      white-space: pre-wrap;
      word-break: break-all;
      color: #cdd6f4;
      background: #11111b55;
    `;
    
    entryBody.textContent = JSON.stringify(dataPayload, null, 2);

    logEntry.appendChild(entryHeader);
    logEntry.appendChild(entryBody);
    logContainer.appendChild(logEntry);

    // Auto-scroll downwards
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  // ── 5. Scanning Core ──────────────────────────────────────────────────────

  function scanForCalls() {
    const allText = document.body.innerText || "";
    const pattern = /__AGENT_CALL__([\s\S]*?)__END__/g;
    let match;

    while ((match = pattern.exec(allText)) !== null) {
      const raw = match[1].trim();
      if (processedCalls.has(raw)) continue;
      processedCalls.add(raw);

      handleAgentCall(raw);
    }
  }

  async function handleAgentCall(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      logToTerminal("error", "Parsing Exception", { error: "Could not parse payload JSON", raw });
      return;
    }

    const { op, ...params } = parsed;
    logToTerminal("request", `📡 OUTGOING: ${op.toUpperCase()}`, { op, params });

    chrome.runtime.sendMessage(
      { type: "AGENT_CALL", op, params },
      (response) => {
        if (chrome.runtime.lastError) {
          logToTerminal("error", `❌ RUNTIME ERROR: ${op}`, { error: chrome.runtime.lastError.message });
          return;
        }

        const result = response?.result || { ok: false, error: "No response from background worker." };
        
        if (result.ok || response.success) {
          logToTerminal("success", `📥 SUCCESS: ${op.toUpperCase()}`, result);
        } else {
          logToTerminal("error", `❌ FAILED: ${op.toUpperCase()}`, result);
        }
      }
    );
  }

  // ── Initializers ──────────────────────────────────────────────────────────
  initializeTerminal();
  scanForCalls();
  setInterval(scanForCalls, SCAN_INTERVAL);

  const observer = new MutationObserver(() => scanForCalls());
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  console.log("[VibesCode] Scrolling & Maximize Features Enabled.");
})();