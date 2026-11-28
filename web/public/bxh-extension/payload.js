// What the extension sends to the runner, kept free of browser APIs so it can be tested.

/** The origin of an http(s) page, or null for anything else (chrome://, file://, about:blank). */
export function pageOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** The runner's address as typed, reduced to its origin; null if it is not an http(s) address. */
export function runnerOrigin(input) {
  const typed = String(input ?? "").trim();
  if (!typed) return null;
  return pageOrigin(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `http://${typed}`);
}

/** The most custom login headers kept for one site. */
export const MAX_HEADERS = 8;

/**
 * Is this request header part of how the app proves who is logged in? Authorization, and a
 * custom header whose name says token, auth, csrf, xsrf, session or api key
 * (X-Auth-Token, X-CSRF-Token, X-Authenticity-Token, X-Api-Key). Cookies travel separately.
 */
export function isAuthHeader(name) {
  const n = String(name ?? "").toLowerCase();
  if (n === "authorization") return true;
  return /^x-[a-z0-9-]{1,60}$/.test(n) && /(token|auth|csrf|xsrf|session|api-?key)/.test(n);
}

/** A pairing code as the recon dialog shows it: 32 letters, digits, - or _. */
export function isPairingCode(code) {
  return /^[A-Za-z0-9_-]{20,64}$/.test(String(code ?? ""));
}

/**
 * The body of the post: the page's origin, its cookies as the browser holds them, and the
 * login headers seen for that same origin (Authorization, and custom ones by name). Nothing
 * else leaves the browser.
 */
export function buildPayload(origin, cookies, seen) {
  const body = {
    origin,
    cookies: (cookies ?? []).map((c) => ({
      name: c.name, value: c.value, domain: c.domain, hostOnly: c.hostOnly === true, path: c.path,
      secure: c.secure === true, httpOnly: c.httpOnly === true,
      ...(typeof c.expirationDate === "number" ? { expirationDate: c.expirationDate } : {}),
    })),
  };
  if (seen && seen.origin === origin) {
    if (typeof seen.value === "string" && seen.value) body.authorization = seen.value;
    const headers = Object.entries(seen.headers ?? {})
      .filter(([name, value]) => isAuthHeader(name) && name.toLowerCase() !== "authorization" && typeof value === "string" && value)
      .slice(0, MAX_HEADERS).map(([name, value]) => ({ name: name.toLowerCase(), value }));
    if (headers.length) body.headers = headers;
  }
  return body;
}

/** What has been seen so far for this site, for the popup's status line. */
export function seenSummary(origin, seen) {
  if (!seen || seen.origin !== origin) return "";
  const names = [...(seen.value ? ["Authorization"] : []), ...Object.keys(seen.headers ?? {})];
  return names.length ? `seen: ${names.join(", ")}` : "";
}

/** One line on what was sent, from the runner's reply. */
export function sentSummary(session) {
  const n = session?.cookies ?? 0;
  const parts = [`${n} cookie${n === 1 ? "" : "s"}`];
  if (session?.authorization) parts.push("the Authorization header");
  for (const h of session?.headers ?? []) parts.push(`the ${h} header`);
  const list = parts.length > 2 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join(" and ");
  return `Sent ${list} for ${session?.target ?? "the target"}.`;
}
