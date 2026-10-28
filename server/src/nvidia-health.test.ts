import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bxh-nv-"));
process.env.OPEN_RUNNER_VAULT_FILE = path.join(dir, "vault.json");
process.env.OPEN_RUNNER_NVIDIA_PROBE_GAP_MS = "0";
const health = await import("./nvidia-health.js");

beforeEach(() => {
  fs.rmSync(health.HEALTH_FILE, { force: true });
  health._reset();
});

describe("nvidia model health", () => {
  it("keeps its file next to the vault", () => {
    expect(path.dirname(health.HEALTH_FILE)).toBe(dir);
  });

  it("hides a model after a 404 and brings it back after a success", () => {
    health.markRetired("google/gemma-2b");
    expect(health.isRetired("google/gemma-2b")).toBe(true);
    health._reset(); // survives a restart
    expect(health.isRetired("google/gemma-2b")).toBe(true);
    health.markAlive("google/gemma-2b");
    expect(health.isRetired("google/gemma-2b")).toBe(false);
  });

  it("probes once a day, marking only 404s as retired", async () => {
    const seen: string[] = [];
    const probe = async (id: string) => {
      seen.push(id);
      return id === "dead" ? "missing" as const : id === "flaky" ? "unknown" as const : "ok" as const;
    };
    health.markRetired("back");
    await health.probeIfDue(["live", "dead", "flaky", "back"], probe);
    expect(health.retiredIds()).toEqual(["dead"]);
    expect(health.status().checkedAt).toBeTruthy();

    await health.probeIfDue(["live", "dead"], probe); // not due again
    expect(seen).toHaveLength(4);
    await health.probeIfDue(["live"], probe, true); // forced
    expect(seen).toHaveLength(5);
  });

  it("shares one probe between concurrent callers", async () => {
    let calls = 0;
    const probe = async () => { calls++; return "ok" as const; };
    await Promise.all([health.probeIfDue(["a", "b"], probe), health.probeIfDue(["a", "b"], probe)]);
    expect(calls).toBe(2);
  });
});
