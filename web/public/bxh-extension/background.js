/* global chrome */
// Remembers the last login headers the watched site sent (Authorization, and custom ones such
// as X-Auth-Token or X-CSRF-Token), in memory only (chrome.storage.session is cleared when the
// browser closes), until the popup sends them.
import { isAuthHeader, MAX_HEADERS } from "./payload.js";

const WATCH_MS = 15 * 60_000;

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const found = (details.requestHeaders ?? []).filter((h) => h.value && isAuthHeader(h.name));
    if (!found.length) return;
    void chrome.storage.session.get(["watching", "seen"]).then(({ watching, seen }) => {
      if (!watching || Date.now() - watching.since > WATCH_MS) return;
      let origin;
      try { origin = new URL(details.url).origin; } catch { return; }
      if (origin !== watching.origin) return; // only the site the person chose to capture
      const next = seen?.origin === origin ? { origin, value: seen.value, headers: { ...seen.headers } } : { origin, headers: {} };
      for (const h of found) {
        const name = h.name.toLowerCase();
        if (name === "authorization") next.value = h.value;
        else if (name in next.headers || Object.keys(next.headers).length < MAX_HEADERS) next.headers[name] = h.value; // the latest value wins
      }
      return chrome.storage.session.set({ seen: next });
    });
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["requestHeaders", "extraHeaders"],
);
