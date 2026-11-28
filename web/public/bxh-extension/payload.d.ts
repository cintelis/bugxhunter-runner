export interface BrowserCookie {
  name: string; value: string; domain: string; hostOnly?: boolean; path: string;
  secure?: boolean; httpOnly?: boolean; expirationDate?: number;
}
export function pageOrigin(url: string): string | null;
export function runnerOrigin(input: unknown): string | null;
export const MAX_HEADERS: number;
export function isAuthHeader(name: unknown): boolean;
export function isPairingCode(code: unknown): boolean;
export interface SeenHeaders { origin: string; value?: string; headers?: Record<string, string> }
export function seenSummary(origin: string, seen?: SeenHeaders | null): string;
export function buildPayload(origin: string, cookies: readonly BrowserCookie[] | undefined, seen?: SeenHeaders | null): {
  origin: string;
  cookies: { name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; httpOnly: boolean; expirationDate?: number }[];
  authorization?: string;
  headers?: { name: string; value: string }[];
};
export function sentSummary(session: { cookies?: number; authorization?: boolean; headers?: readonly string[]; target?: string } | null | undefined): string;
