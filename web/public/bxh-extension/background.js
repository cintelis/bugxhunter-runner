/* global chrome */
// Remembers the last Authorization header the watched site sent, in memory only
// (chrome.storage.session is cleared when the browser closes), until the popup sends it.

const WATCH_MS = 15 * 60_000;

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const header = details.requestHeaders?.find((h) => h.name.toLowerCase() === "authorization");
    if (!header?.value) return;
    void chrome.storage.session.get("watching").then(({ watching }) => {
      if (!watching || Date.now() - watching.since > WATCH_MS) return;
      let origin;
      try { origin = new URL(details.url).origin; } catch { return; }
      if (origin !== watching.origin) return; // only the site the person chose to capture
      return chrome.storage.session.set({ seen: { origin, value: header.value } });
    });
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["requestHeaders", "extraHeaders"],
);
