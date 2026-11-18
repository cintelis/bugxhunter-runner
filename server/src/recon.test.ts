import { describe, it, expect } from "vitest";
import { routeModel, classifyCommand, RECON_MODELS } from "./recon.js";

describe("routeModel — the intelligent router", () => {
  it("puts each role on its baseline model", () => {
    expect(routeModel("executor")).toBe(RECON_MODELS.executor);
    expect(routeModel("triage")).toBe(RECON_MODELS.triage);
    expect(routeModel("verify")).toBe(RECON_MODELS.verify);
    expect(routeModel("escalate")).toBe(RECON_MODELS.escalate);
  });

  it("escalates a stuck executor to the top tier", () => {
    expect(routeModel("executor", { attempts: 3 })).toBe(RECON_MODELS.escalate);
  });

  it("escalates on a high/critical candidate", () => {
    expect(routeModel("executor", { severityHint: "critical" })).toBe(RECON_MODELS.escalate);
  });

  it("does NOT escalate for routine work", () => {
    expect(routeModel("executor", { attempts: 1, severityHint: "low" })).toBe(RECON_MODELS.executor);
  });

  it("sheds a capped top-tier model down to the mid tier (the ARTEX 429 fix)", () => {
    // Escalate picks Mythos; Mythos alone is at its per-model cap -> shed to Sonnet.
    const picked = routeModel("executor", { attempts: 3, rateLimited: { [RECON_MODELS.escalate]: true } });
    expect(picked).toBe(RECON_MODELS.verify); // Sonnet, a different model with its own limit
  });

  it("grinds on GLM when the whole anthropic provider is down", () => {
    const picked = routeModel("verify", { rateLimited: { anthropic: true } });
    expect(picked).toBe(RECON_MODELS.executor); // GLM on scx, the healthy provider
  });

  it("avoids the pricey tier when the budget is spent", () => {
    expect(routeModel("executor", { severityHint: "high", budgetRemaining: 0 })).not.toBe(RECON_MODELS.escalate);
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

  it("asks on a POST even if it looks curl-ish", () => {
    expect(classifyCommand("curl --request PUT http://target/x")).toBe("ask");
  });

  it("fails closed on anything unrecognised", () => {
    expect(classifyCommand("./some-unknown-binary --go")).toBe("ask");
  });
});
