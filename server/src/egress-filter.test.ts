import { describe, it, expect } from "vitest";
// The enforce-mode egress logic lives with the sidecar (plain ESM, shipped in the
// agent image), but it is pure, so we unit-test it from the server workspace.
import {
  egressMode, parseAllow, readPolicy, ipInCidr, ipAllowed, buildChainRules, renderRestore, EGRESS_CHAIN,
} from "../../docker/egress-filter.mjs";

describe("egressMode", () => {
  it("defaults to monitor; only an exact 'enforce' enables blocking", () => {
    expect(egressMode(undefined)).toBe("monitor");
    expect(egressMode("")).toBe("monitor");
    expect(egressMode("log")).toBe("monitor");
    expect(egressMode("  Enforce ")).toBe("enforce");
    expect(egressMode("enforce")).toBe("enforce");
  });
});

describe("parseAllow", () => {
  it("separates hosts from IPv4/IPv6 literals and CIDRs", () => {
    const a = parseAllow("target.example, 10.0.0.0/8, 1.2.3.4, 2001:db8::1, oob.collab:443, https://scan.me/path");
    expect(a.hosts).toEqual(expect.arrayContaining(["target.example", "oob.collab", "scan.me"]));
    expect(a.literals).toContainEqual({ addr: "10.0.0.0/8", family: "inet" });
    expect(a.literals).toContainEqual({ addr: "1.2.3.4", family: "inet" });
    expect(a.literals).toContainEqual({ addr: "2001:db8::1", family: "inet6" });
  });
  it("drops junk and de-dupes", () => {
    const a = parseAllow("good.example, , 999.1.1.1, bad!!, good.example");
    expect(a.hosts).toEqual(["good.example"]);          // de-duped, junk removed
    expect(a.literals).toEqual([]);                      // 999.x.x.x is not a valid octet
  });
  it("tolerates empty / undefined", () => {
    expect(parseAllow(undefined)).toEqual({ hosts: [], literals: [] });
  });
});

describe("readPolicy — env default with a file override (the runtime toggle)", () => {
  it("uses env when there is no file", () => {
    const p = readPolicy({ EGRESS_MODE: "enforce", EGRESS_ALLOW: "a.example" }, undefined);
    expect(p.mode).toBe("enforce");
    expect(p.allow.hosts).toEqual(["a.example"]);
  });
  it("a valid policy file overrides the env per-key", () => {
    const p = readPolicy({ EGRESS_MODE: "monitor", EGRESS_ALLOW: "env.example" },
      JSON.stringify({ mode: "enforce", allow: ["file.example", "203.0.113.0/24"] }));
    expect(p.mode).toBe("enforce");
    expect(p.allow.hosts).toEqual(["file.example"]);
    expect(p.allow.literals).toContainEqual({ addr: "203.0.113.0/24", family: "inet" });
  });
  it("a file that sets only mode keeps the env allow list", () => {
    const p = readPolicy({ EGRESS_MODE: "monitor", EGRESS_ALLOW: "env.example" },
      JSON.stringify({ mode: "enforce" }));
    expect(p.mode).toBe("enforce");
    expect(p.allow.hosts).toEqual(["env.example"]);
  });
  it("env=enforce is a FLOOR: a file cannot lower it to monitor", () => {
    const p = readPolicy({ EGRESS_MODE: "enforce", EGRESS_ALLOW: "env.example" },
      JSON.stringify({ mode: "monitor", allow: ["x.example"] }));
    expect(p.mode).toBe("enforce");                 // file could not downgrade
    expect(p.allow.hosts).toEqual(["x.example"]);   // but its allow list still applied
    expect(p.fileInvalid).toBe(false);
  });
  it("a malformed file is flagged invalid and the env is used (fails safe, not open)", () => {
    const p = readPolicy({ EGRESS_MODE: "enforce", EGRESS_ALLOW: "env.example" }, "{ not json");
    expect(p.mode).toBe("enforce");
    expect(p.allow.hosts).toEqual(["env.example"]);
    expect(p.fileInvalid).toBe(true);
  });
  it("an unknown mode string is flagged invalid, not silently treated as monitor", () => {
    const p = readPolicy({ EGRESS_MODE: "enforce", EGRESS_ALLOW: "env.example" },
      JSON.stringify({ mode: "enforced" }));
    expect(p.fileInvalid).toBe(true);
    expect(p.mode).toBe("enforce");                 // held at the env floor
  });
});

describe("ipInCidr / ipAllowed", () => {
  it("matches IPv4 CIDRs correctly", () => {
    expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("11.1.2.3", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("192.168.1.9", "192.168.1.0/24")).toBe(true);
    expect(ipInCidr("192.168.2.9", "192.168.1.0/24")).toBe(false);
    expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
  });
  it("tags an in-scope IPv4 destination against the allow set", () => {
    const allow = parseAllow("203.0.113.0/24, 198.51.100.7, target.example");
    expect(ipAllowed("203.0.113.55", allow)).toBe(true);   // in the CIDR
    expect(ipAllowed("198.51.100.7", allow)).toBe(true);   // exact literal
    expect(ipAllowed("8.8.8.8", allow)).toBe(false);       // off-scope
  });
});

describe("buildChainRules — the deny-by-default ruleset", () => {
  it("allows lo, then PINNED DNS, then each destination, then LOG + REJECT last", () => {
    const rules = buildChainRules(["203.0.113.5", "198.51.100.0/24"], "inet", ["9.9.9.9"]);
    expect(rules[0]).toEqual(["-A", EGRESS_CHAIN, "-o", "lo", "-j", "ACCEPT"]);
    // DNS is pinned to the resolver, NOT opened to every host on port 53.
    expect(rules).toContainEqual(["-A", EGRESS_CHAIN, "-d", "9.9.9.9", "-p", "udp", "--dport", "53", "-j", "ACCEPT"]);
    expect(rules).toContainEqual(["-A", EGRESS_CHAIN, "-d", "9.9.9.9", "-p", "tcp", "--dport", "53", "-j", "ACCEPT"]);
    // No blanket port-53 accept (the bypass #1).
    expect(rules).not.toContainEqual(["-A", EGRESS_CHAIN, "-p", "udp", "--dport", "53", "-j", "ACCEPT"]);
    // No blanket ESTABLISHED accept (#7).
    expect(rules.some((r) => r.includes("ESTABLISHED,RELATED"))).toBe(false);
    expect(rules).toContainEqual(["-A", EGRESS_CHAIN, "-d", "203.0.113.5", "-j", "ACCEPT"]);
    expect(rules).toContainEqual(["-A", EGRESS_CHAIN, "-d", "198.51.100.0/24", "-j", "ACCEPT"]);
    expect(rules.at(-1)).toEqual(["-A", EGRESS_CHAIN, "-j", "REJECT", "--reject-with", "icmp-admin-prohibited"]);
    expect(rules.at(-2)?.includes("LOG")).toBe(true);
    // The LOG prefix is space-free so iptables-restore needs no quoting.
    expect(rules.at(-2)?.at(-1)).toBe("bxh-egress-deny:");
  });
  it("uses the IPv6 reject target for the inet6 family", () => {
    const rules = buildChainRules([], "inet6");
    expect(rules.at(-1)).toEqual(["-A", EGRESS_CHAIN, "-j", "REJECT", "--reject-with", "icmp6-adm-prohibited"]);
  });
  it("with no destinations and no resolvers, only loopback is allowed before REJECT", () => {
    const rules = buildChainRules([], "inet", []);
    const accepts = rules.filter((r) => r.includes("ACCEPT"));
    expect(accepts).toEqual([["-A", EGRESS_CHAIN, "-o", "lo", "-j", "ACCEPT"]]);
    expect(rules.at(-1)?.includes("REJECT")).toBe(true);
  });
});

describe("renderRestore — atomic apply document", () => {
  it("wraps the chain in a flush-and-repopulate transaction", () => {
    const text = renderRestore(buildChainRules(["203.0.113.5"], "inet", []));
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("*filter");
    expect(lines[1]).toBe(`:${EGRESS_CHAIN} - [0:0]`);   // create-or-flush atomically
    expect(lines).toContain(`-A ${EGRESS_CHAIN} -d 203.0.113.5 -j ACCEPT`);
    expect(lines.at(-1)).toBe("COMMIT");
    expect(text).not.toContain('"');                      // no quoting hazards
  });
});
