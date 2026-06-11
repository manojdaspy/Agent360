chrome.runtime.onInstalled.addListener(() => {
  console.log("[VibesCode] Extension installed");
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[VibesCode] Extension started");
});

// ── Regular fetch relay ───────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ ok: true, pong: true });
    return true;
  }

  if (msg.type === "LOG") {
    console.log("[CONTENT]", msg.data);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "FETCH") {
    fetch(msg.url, {
      method:  msg.method  || "GET",
      headers: msg.headers || {},
      body:    msg.body ?? undefined,
    })
      .then(async r => ({
        ok:     r.ok,
        status: r.status,
        body:   await r.text(),
      }))
      .then(data => sendResponse(data))
      .catch(err  => sendResponse({ error: err.message }));
    return true;
  }
});

// ── SSE proxy via long-lived port ─────────────────────────────────────────
// Content script connects with: chrome.runtime.connect({ name: "SSE_PROXY" })
// Then sends: { url, eventNames }
// Background opens EventSource, forwards events back over the port
// ─────────────────────────────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "SSE_PROXY") return;

  let es = null;

  port.onMessage.addListener((msg) => {
    if (msg.type !== "OPEN") return;

    const url        = msg.url;
    const eventNames = msg.eventNames || ["message"];

    console.log("[VibesCode BG] SSE proxy opening:", url);
    es = new EventSource(url);

    es.onopen = () => {
      port.postMessage({ type: "open" });
    };

    es.onerror = () => {
      port.postMessage({ type: "error" });
      es.close();
    };

    // Forward every named event type the caller requested
    for (const name of eventNames) {
      es.addEventListener(name, (e) => {
        port.postMessage({ type: "event", name, data: e.data });
      });
    }
  });

  // Clean up when content script disconnects / page unloads
  port.onDisconnect.addListener(() => {
    console.log("[VibesCode BG] SSE proxy port disconnected, closing EventSource");
    if (es) { es.close(); es = null; }
  });
});