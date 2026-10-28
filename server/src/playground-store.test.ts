import { beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Scratch vault + store before the modules read their paths.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bxh-pg-"));
process.env.OPEN_RUNNER_VAULT_FILE = path.join(dir, "vault.json");
const vault = await import("./vault.js");
const store = await import("./playground-store.js");

const dek = crypto.randomBytes(32);
function setUpVault() {
  const now = new Date().toISOString();
  vault.initialise({
    version: 1,
    createdAt: now,
    methods: [{
      type: "passkey", id: "pk-1", label: "test", credentialId: "AAAA", prfSalt: "s", hkdfSalt: "s",
      wrapped: { iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" }, createdAt: now,
    }],
    verifier: vault.seal(dek, "bugxhunter-vault-ok", "verifier"),
    items: {},
  } as never, dek.toString("base64"));
}

beforeEach(() => {
  vault.sealVault();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});

const ID = "abcdef12-3456";

describe("playground store", () => {
  it("lives next to the vault, so Docker puts it on the runner-only data volume", () => {
    expect(store.PLAYGROUND_DIR).toBe(path.join(dir, "playground"));
  });

  it("refuses to save without a vault, and while it is sealed", () => {
    expect(() => store.put("chat", ID, "t", {})).toThrow(/Set up the vault/);
    setUpVault();
    vault.sealVault();
    expect(() => store.put("chat", ID, "t", {})).toThrow(/sealed/);
  });

  it("round-trips a session and keeps title and body out of the file in the clear", () => {
    setUpVault();
    store.put("chat", ID, "Acme Bank prod review", { messages: [{ role: "user", content: "AKIA-SECRET-MARKER" }] });
    const raw = fs.readFileSync(path.join(store.PLAYGROUND_DIR, `chat-${ID}.json`), "utf8");
    expect(raw).not.toContain("Acme Bank");
    expect(raw).not.toContain("AKIA-SECRET-MARKER");
    expect(store.list("chat")).toMatchObject([{ id: ID, title: "Acme Bank prod review" }]);
    expect(store.list("canvas")).toEqual([]);
    expect(store.get("chat", ID).body).toEqual({ messages: [{ role: "user", content: "AKIA-SECRET-MARKER" }] });
  });

  it("can't open a blob moved to another record (the AAD binds it)", () => {
    setUpVault();
    store.put("chat", ID, "one", { a: 1 });
    const f = (id: string) => path.join(store.PLAYGROUND_DIR, `chat-${id}.json`);
    const moved = JSON.parse(fs.readFileSync(f(ID), "utf8"));
    fs.writeFileSync(f("other-id-0001"), JSON.stringify({ ...moved, id: "other-id-0001" }));
    expect(() => store.get("chat", "other-id-0001")).toThrow(/does not open/);
    expect(store.list("chat").map((s) => s.id)).toEqual([ID]);
  });

  it("rejects ids that could escape the folder, and unknown kinds", () => {
    setUpVault();
    expect(() => store.put("chat", "../../etc/passwd", "t", {})).toThrow(/Malformed/);
    expect(() => store.get("chat", "..%2fvault")).toThrow(/Malformed/);
    expect(() => store.list("notes" as never)).toThrow(/Unknown/);
  });

  it("deletes one or all of a kind", () => {
    setUpVault();
    store.put("chat", ID, "a", {});
    store.put("chat", "second-id-02", "b", {});
    store.put("canvas", ID, "c", {});
    store.remove("chat", ID);
    expect(store.list("chat").map((s) => s.id)).toEqual(["second-id-02"]);
    expect(store.removeAll("chat")).toBe(1);
    expect(store.list("chat")).toEqual([]);
    expect(store.list("canvas")).toHaveLength(1);
  });
});
