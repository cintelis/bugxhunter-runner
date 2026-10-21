/**
 * Request rate limits, per client IP, per minute.
 *
 * The runner is single-user and localhost-only by default, so these are not
 * about load: they cap what a script on the same machine (or a page that got
 * past the Host check) can do in a burst, and they make the sign-in routes
 * useless for guessing. The general limit sits well above what the UI itself
 * sends (status polls, session lists, one SSE stream).
 */
import { rateLimit } from "express-rate-limit";

const limiter = (limit: number, what: string) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: { message: `Too many ${what} requests; try again in a minute.`, code: "rate_limited" } },
  });

/** Everything under /api. */
export const apiLimiter = limiter(1200, "API");
/** Sign-in: challenge, passkey assertion, recovery. */
export const authLimiter = limiter(30, "sign-in");
/** File downloads from the project folder. */
export const fileLimiter = limiter(120, "download");
/** The built web app (production). */
export const staticLimiter = limiter(1200, "page");
