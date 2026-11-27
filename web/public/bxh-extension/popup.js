/* global chrome */
import { buildPayload, pageOrigin, runnerOrigin, sentSummary } from "./payload.js";

const $ = (id) => document.getElementById(id);
const status = (text, kind = "") => { $("status").textContent = text; $("status").className = kind; };

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const origin = pageOrigin(tab?.url ?? "");
$("site").textContent = origin ?? "Open the target's page in this tab first.";
$("watch").disabled = $("send").disabled = !origin;

const saved = await chrome.storage.local.get("runner");
$("runner").value = saved.runner ?? "http://localhost:8790";

const { watching, seen } = await chrome.storage.session.get(["watching", "seen"]);
if (origin && watching?.origin === origin) {
  status(seen?.origin === origin ? "Watching: an Authorization header was seen. Send when you are logged in." : "Watching this site. Log in, then send.");
}

// permissions.request must be the first thing a click does, or the browser refuses it.
const allow = (origins) => chrome.permissions.request({ origins: origins.map((o) => `${o}/*`) });
const CLOSED = " If this window closed while you allowed access, open it again and press the button once more.";

$("watch").addEventListener("click", async () => {
  try {
    if (!(await allow([origin]))) return status("Access to this site was not allowed, so it cannot be watched.", "bad");
    await chrome.storage.session.set({ watching: { origin, since: Date.now() } });
    await chrome.storage.session.remove("seen");
    status("Watching this site for 15 minutes. Log in and open a page that needs the login, then send.");
  } catch (e) {
    status(`Could not start watching: ${e.message}.${CLOSED}`, "bad");
  }
});

$("send").addEventListener("click", async () => {
  const runner = runnerOrigin($("runner").value);
  const code = $("code").value.trim();
  if (!runner) return status("Enter the runner's address, for example http://localhost:8790.", "bad");
  if (!code) return status("Paste the pairing code from BugXHunter's recon dialog.", "bad");
  try {
    if (!(await allow([origin, runner]))) return status("Access was not allowed, so nothing was sent.", "bad");
    $("send").disabled = true;
    await chrome.storage.local.set({ runner });
    const cookies = await chrome.cookies.getAll({ url: tab.url });
    const { seen: header } = await chrome.storage.session.get("seen");
    const r = await fetch(`${runner}/api/capture/session`, {
      method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${code}` },
      body: JSON.stringify(buildPayload(origin, cookies, header)),
    });
    const reply = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(reply?.error?.message ?? `the runner answered ${r.status}`);
    await chrome.storage.session.remove(["watching", "seen"]);
    $("code").value = "";
    status(`${sentSummary(reply.session)} You can close this and start the run.`, "good");
  } catch (e) {
    status(`Not sent: ${e.message}.${CLOSED}`, "bad");
  } finally {
    $("send").disabled = false;
  }
});
