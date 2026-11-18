import { describe, it, expect, afterEach } from "vitest";
import {
  routeModel, classifyCommand, modelFor, harnessFor,
  activeProfileName, profileNames, parseProfile, parseReconHarness,
  DEFAULT_PROFILE, BUILTIN_PROFILES,
} from "./recon.js";

describe("profiles", () => {
  it("defaults to recon-balanced", () => {
    expect(activeProfileName()).toBe(DEFAULT_PROFILE);
    expect(DEFAULT_PROFILE).toBe("recon-balanced");
  });

  it("lists the built-in profiles", () => {
    const names = profileNames();
    expect(names).toEqual(expect.arrayContaining(["recon-open", "recon-balanced", "recon-quality"]));
  });

  it("maps each role to the active profile's model", () => {
    const p = BUILTIN_PROFILES[DEFAULT_PROFILE];
    expect(modelFor("executor")).toBe(p.models.executor);
    expect(modelFor("triage")).toBe(p.models.triage);
    expect(modelFor("verify")).toBe(p.models.verify);
    expect(modelFor("escalate")).toBe(p.models.escalate);
  });

  it("exposes the per-role harness (executor runs core tools)", () => {
    expect(harnessFor("executor").tools).toBe("core");
    expect(harnessFor("executor").budgetTokens).toBeGreaterThan(0);
  });
});

describe("profile parsing — graceful degradation", () => {
  it("rejects a profile missing a role model", () => {
    expect(parseProfile({ models: { executor: "a", triage: "b", verify: "c" } })).toBeNull();
    expect(parseProfile({ nope: true })).toBeNull();
  });

  it("accepts a full profile and keeps a valid harness", () => {
    const p = parseProfile({
      models: { executor: "scx/x", triage: "scx/y", verify: "a/z", escalate: "a/w" },
      harness: { executor: { tools: "full", budgetTokens: 5, maxRounds: 10, effort: "high" } },
    });
    expect(p?.models.executor).toBe("scx/x");
    expect(p?.harness?.executor?.tools).toBe("full");
  });

  it("drops bad harness fields instead of crashing", () => {
    expect(parseReconHarness({ tools: "nonsense", budgetTokens: -5, effort: "ludicrous" })).toBeUndefined();
    expect(parseReconHarness({ tools: "core", maxRounds: 0 })?.maxRounds).toBeUndefined();
  });
});

describe("routeModel — the intelligent router", () => {
  const P = BUILTIN_PROFILES[DEFAULT_PROFILE].models;

  it("puts each role on its baseline model", () => {
    expect(routeModel("executor")).toBe(P.executor);
    expect(routeModel("verify")).toBe(P.verify);
  });

  it("escalates a stuck executor to the top tier", () => {
    expect(routeModel("executor", { attempts: 3 })).toBe(P.escalate);
  });

  it("escalates on a high/critical candidate", () => {
    expect(routeModel("executor", { severityHint: "critical" })).toBe(P.escalate);
  });

  it("does NOT escalate for routine work", () => {
    expect(routeModel("executor", { attempts: 1, severityHint: "low" })).toBe(P.executor);
  });

  it("sheds a capped top-tier model down to the mid tier (the ARTEX 429 fix)", () => {
    // Escalate picks Mythos; Mythos alone is at its per-model cap -> shed to Sonnet.
    const picked = routeModel("executor", { attempts: 3, rateLimited: { [P.escalate]: true } });
    expect(picked).toBe(P.verify); // Sonnet, a different model with its own limit
  });

  it("grinds on the executor model when the whole anthropic provider is down", () => {
    const picked = routeModel("verify", { rateLimited: { anthropic: true } });
    expect(picked).toBe(P.executor); // GLM on scx, the healthy provider
  });

  it("avoids the pricey tier when the budget is spent", () => {
    expect(routeModel("executor", { severityHint: "high", budgetRemaining: 0 })).not.toBe(P.escalate);
  });
});

describe("modelFor — env override", () => {
  afterEach(() => { delete process.env.RECON_EXECUTOR_MODEL; });

  it("lets a per-role env var win over the profile", () => {
    process.env.RECON_EXECUTOR_MODEL = "openrouter/custom-model";
    expect(modelFor("executor")).toBe("openrouter/custom-model");
  });
});

describe("classifyCommand — risk-tiered approval", () => {
  it("auto-allows read-only recon", () => {
    expect(classifyCommand("curl -s http://target/api/runs")).toBe("allow");
    expect(classifyCommand("nmap -sV target")).toBe("allow");
    expect(classifyCommand("dig target")).toBe("allow");
    expect(classifyCommand("grep -i cookie saved.html")).toBe("allow");
  });

  it("always asks on state-changing requests", () => {
    expect(classifyCommand("curl -X DELETE http://target/api/runs/1")).toBe("ask");
    expect(classifyCommand("curl -X POST -d 'x=1' http://target/api/session")).toBe("ask");
    expect(classifyCommand("rm -rf /tmp/x")).toBe("ask");
  });

  it("asks on a PUT even if it looks curl-ish", () => {
    expect(classifyCommand("curl --request PUT http://target/x")).toBe("ask");
  });

  it("fails closed on anything unrecognised", () => {
    expect(classifyCommand("./some-unknown-binary --go")).toBe("ask");
  });
});
