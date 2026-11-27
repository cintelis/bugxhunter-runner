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

/**
 * The body of the post: the page's origin, its cookies as the browser holds them, and the
 * Authorization header if one was seen for that same origin. Nothing else leaves the browser.
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
  if (seen && seen.origin === origin && typeof seen.value === "string" && seen.value) body.authorization = seen.value;
  return body;
}

/** One line on what was sent, from the runner's reply. */
export function sentSummary(session) {
  const n = session?.cookies ?? 0;
  const parts = [`${n} cookie${n === 1 ? "" : "s"}`];
  if (session?.authorization) parts.push("the Authorization header");
  return `Sent ${parts.join(" and ")} for ${session?.target ?? "the target"}.`;
}
