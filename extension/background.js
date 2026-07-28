// Relays fetches to the local Reddit Radar server. Content scripts run in
// the page's own origin (reddit.com), so a direct fetch() from content.js
// would be blocked by the page's CORS policy; the service worker has no
// such restriction once localhost:4321 is declared in host_permissions.
const SERVER = "http://localhost:4321";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "rr-fetch") return;
  fetch(`${SERVER}${msg.path}`, msg.options)
    .then(async (res) => {
      const data = await res.json().catch(() => null);
      sendResponse({ ok: res.ok, status: res.status, data });
    })
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // keep the message channel open for the async sendResponse
});
