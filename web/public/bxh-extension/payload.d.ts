export interface BrowserCookie {
  name: string; value: string; domain: string; hostOnly?: boolean; path: string;
  secure?: boolean; httpOnly?: boolean; expirationDate?: number;
}
export function pageOrigin(url: string): string | null;
export function runnerOrigin(input: unknown): string | null;
export function buildPayload(origin: string, cookies: readonly BrowserCookie[] | undefined, seen?: { origin: string; value: string } | null): {
  origin: string;
  cookies: { name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; httpOnly: boolean; expirationDate?: number }[];
  authorization?: string;
};
export function sentSummary(session: { cookies?: number; authorization?: boolean; target?: string } | null | undefined): string;
