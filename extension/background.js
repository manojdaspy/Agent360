chrome.runtime.onInstalled.addListener(() => {
  console.log("[VibesCode] Extension installed");
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[VibesCode] Extension started");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[VibesCode] Message:", msg);

  if (msg.type === "PING") {
    sendResponse({ ok: true, pong: true });
  }

  if (msg.type === "LOG") {
    console.log("[CONTENT]", msg.data);
    sendResponse({ ok: true });
  }

  return true;
});