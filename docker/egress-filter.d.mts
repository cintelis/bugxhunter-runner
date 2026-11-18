// Types for the pure egress-allowlist logic in egress-filter.mjs, so the server
// workspace's unit test (server/src/egress-filter.test.ts) type-checks. The
// runtime module is plain ESM shipped in the agent image.

export type EgressMode = "monitor" | "enforce";
export type Family = "inet" | "inet6";
export interface AllowLiteral { addr: string; family: Family }
export interface AllowList { hosts: string[]; literals: AllowLiteral[] }
export interface Policy { mode: EgressMode; allow: AllowList }

export function egressMode(raw: unknown): EgressMode;
export function isV6(s: string): boolean;
export function parseAllow(raw: unknown): AllowList;
export function readPolicy(env: Record<string, string | undefined>, fileText: string | undefined): Policy;
export function ip4ToInt(ip: string): number | null;
export function ipInCidr(ip: string, cidr: string): boolean;
export function ipAllowed(ip: string, allow: AllowList): boolean;
export function buildChainRules(acceptAddrs: string[], family?: Family): string[][];
export const EGRESS_CHAIN: string;
