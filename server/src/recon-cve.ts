/**
 * Known vulnerabilities for what a run fingerprinted, looked up live.
 *
 * The executor names each component it identified on the target with its version (a line
 * `RECON-COMPONENT: nginx 1.18.0`, or `RECON-COMPONENT: jquery 3.4.1 npm` when it knows the
 * package ecosystem). The runner, not the agent, asks two public databases what is known
 * about that version, and gives the answers back to the executor as leads to test:
 *
 *  - OSV (api.osv.dev) for a package in an ecosystem (npm, PyPI, Packagist, …);
 *  - NVD (services.nvd.nist.gov) for everything else, by product name and version.
 *
 * What leaves the machine: a component name and a version. Never the target, a URL, a
 * response or anything from the vault. What comes back is data about a version, not about
 * the target: a match is a lead until a probe shows the weakness is really there.
 *
 * Why the runner does it: the recon agents have no web access, on purpose, and a model's
 * memory of CVEs ends at its training date.
 */
import type { ReconComponent, ReconKnownVuln } from "../../shared/agent.js";

export type { ReconComponent, ReconKnownVuln };

/** OSV ecosystems a component line may name, by the lower-case word the executor writes. */
const ECOSYSTEMS: Record<string, string> = {
  npm: "npm", pypi: "PyPI", packagist: "Packagist", composer: "Packagist", rubygems: "RubyGems", gem: "RubyGems",
  go: "Go", maven: "Maven", nuget: "NuGet", "crates.io": "crates.io", cargo: "crates.io", hex: "Hex", pub: "Pub",
};

const NAME = /^[a-z0-9@][a-z0-9._/@+-]{0,79}$/i;
const VERSION = /^v?\d[a-z0-9._+-]{0,39}$/i;

/** The most components one run looks up, and the most one turn can add. */
export const MAX_COMPONENTS = 24;
const MAX_PER_TURN = 12;
/** The most vulnerabilities kept for one component, and for one lookup. */
const MAX_PER_COMPONENT = 6;
const MAX_PER_LOOKUP = 40;
/** NVD allows 5 requests in 30 seconds without a key: at most this many per lookup, spaced out. */
const MAX_NVD = 5;
const NVD_GAP_MS = 6_200;
const REQUEST_TIMEOUT_MS = 12_000;

export const componentKey = (c: Pick<ReconComponent, "name" | "version">) => `${c.name.toLowerCase()}@${c.version.toLowerCase()}`;

/** The component lines of one turn. A line that does not name a product and a version is ignored. */
export function parseComponents(text: string): ReconComponent[] {
  const out: ReconComponent[] = [];
  const seen = new Set<string>();
  for (const line of (text ?? "").split(/\r?\n/)) {
    const m = /^[\s>*_`-]*RECON-COMPONENT:\s*\**\s*(.+)$/i.exec(line);
    if (!m) continue;
    const words = m[1].replace(/[*_`]+/g, " ").trim().split(/\s+/);
    const name = words[0] ?? "";
    const version = (words[1] ?? "").replace(/^v(?=\d)/i, "");
    const eco = ECOSYSTEMS[(words[2] ?? "").toLowerCase().replace(/[()[\],]/g, "")];
    if (!NAME.test(name) || !VERSION.test(version)) continue;
    const c: ReconComponent = { name, version, ...(eco ? { ecosystem: eco } : {}) };
    if (seen.has(componentKey(c))) continue;
    seen.add(componentKey(c));
    out.push(c);
    if (out.length >= MAX_PER_TURN) break;
  }
  return out;
}

const RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const sevOf = (s: unknown): ReconKnownVuln["severity"] => {
  const v = String(s ?? "").toLowerCase();
  if (v === "moderate") return "medium";
  return v in RANK ? (v as ReconKnownVuln["severity"]) : undefined;
};
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function getJson(fetchImpl: Fetch, url: string, init?: Parameters<Fetch>[1]): Promise<unknown> {
  const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** OSV's answer for one package version. */
export function readOsv(body: unknown, c: ReconComponent): ReconKnownVuln[] {
  const out: ReconKnownVuln[] = [];
  for (const v of Array.isArray(obj(body).vulns) ? obj(body).vulns : []) {
    const o = obj(v);
    const aliases = (Array.isArray(o.aliases) ? o.aliases : []).filter((a: unknown): a is string => typeof a === "string");
    const cve = aliases.find((a: string) => /^CVE-\d{4}-\d+$/.test(a));
    const id = cve ?? (typeof o.id === "string" ? o.id : "");
    if (!id) continue;
    out.push({
      id, component: c.name, version: c.version, source: "osv",
      severity: sevOf(obj(o.database_specific).severity),
      summary: clip(o.summary ?? o.details, 220),
      ...(typeof o.published === "string" ? { published: o.published.slice(0, 10) } : {}),
    });
  }
  return out;
}

/** NVD's answer for one product version. */
export function readNvd(body: unknown, c: ReconComponent): ReconKnownVuln[] {
  const out: ReconKnownVuln[] = [];
  for (const v of Array.isArray(obj(body).vulnerabilities) ? obj(body).vulnerabilities : []) {
    const cve = obj(obj(v).cve);
    if (typeof cve.id !== "string" || !/^CVE-\d{4}-\d+$/.test(cve.id)) continue;
    if (/reject/i.test(String(cve.vulnStatus ?? ""))) continue;
    const metrics = obj(cve.metrics);
    const metric = [metrics.cvssMetricV40, metrics.cvssMetricV31, metrics.cvssMetricV30, metrics.cvssMetricV2].find((m) => Array.isArray(m) && m.length);
    const first = obj(metric?.[0]);
    const en = (Array.isArray(cve.descriptions) ? cve.descriptions : []).find((d: unknown) => obj(d).lang === "en");
    out.push({
      id: cve.id, component: c.name, version: c.version, source: "nvd",
      severity: sevOf(obj(first.cvssData).baseSeverity ?? first.baseSeverity),
      summary: clip(obj(en).value, 220),
      ...(typeof cve.published === "string" ? { published: cve.published.slice(0, 10) } : {}),
    });
  }
  return out;
}

/** Worst first, then newest: what is most worth a probe leads the list. */
function worstFirst(a: ReconKnownVuln, b: ReconKnownVuln): number {
  return (RANK[b.severity ?? ""] ?? 0) - (RANK[a.severity ?? ""] ?? 0) || String(b.published ?? "").localeCompare(String(a.published ?? ""));
}

export interface LookupResult {
  vulns: ReconKnownVuln[];
  /** Components a database could not be asked about (it was unreachable, or the NVD allowance for this lookup was used up). */
  unchecked: string[];
}

/**
 * Ask OSV and NVD about each component. Never throws: a database that cannot be reached
 * leaves its components in `unchecked`, and the run goes on without them.
 */
export async function lookupKnownVulns(
  components: readonly ReconComponent[],
  deps: { fetch?: Fetch; wait?: (ms: number) => Promise<void> } = {},
): Promise<LookupResult> {
  const fetchImpl = deps.fetch ?? (fetch as unknown as Fetch);
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const vulns: ReconKnownVuln[] = [];
  const unchecked: string[] = [];
  const keep = (found: ReconKnownVuln[]) => vulns.push(...found.sort(worstFirst).slice(0, MAX_PER_COMPONENT));
  let nvd = 0;
  for (const c of components) {
    const label = `${c.name} ${c.version}`;
    try {
      if (c.ecosystem) {
        keep(readOsv(await getJson(fetchImpl, "https://api.osv.dev/v1/query", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: c.version, package: { name: c.name, ecosystem: c.ecosystem } }),
        }), c));
        continue;
      }
      if (nvd >= MAX_NVD) { unchecked.push(label); continue; }
      if (nvd > 0) await wait(NVD_GAP_MS);
      nvd += 1;
      // A CPE match on product and version, any vendor: NVD's own matching of affected ranges.
      const cpe = `cpe:2.3:a:*:${c.name.toLowerCase().replace(/[^a-z0-9._-]/g, "_")}:${c.version.toLowerCase()}`;
      keep(readNvd(await getJson(fetchImpl, `https://services.nvd.nist.gov/rest/json/cves/2.0?virtualMatchString=${encodeURIComponent(cpe)}&resultsPerPage=50`), c));
    } catch {
      unchecked.push(label);
    }
  }
  return { vulns: vulns.slice(0, MAX_PER_LOOKUP), unchecked };
}

/** Is the live lookup on? Off with RECON_CVE_LOOKUP=off (an air-gapped runner, or a rule against outside calls). */
export function cveLookupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|0|false|no)$/i.test((env.RECON_CVE_LOOKUP ?? "").trim());
}
