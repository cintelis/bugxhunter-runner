import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildPayload, pageOrigin, runnerOrigin, sentSummary } from "../public/bxh-extension/payload.js";

const EXT = path.join(__dirname, "..", "public", "bxh-extension");

describe("the extension's payload", () => {
  it("only works on http(s) pages", () => {
    expect(pageOrigin("https://app.example.com/a/b?c=1")).toBe("https://app.example.com");
    expect(pageOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    for (const u of ["chrome://extensions", "file:///c:/x.html", "about:blank", ""]) expect(pageOrigin(u)).toBeNull();
  });

  it("reduces the runner address to an origin", () => {
    expect(runnerOrigin(" localhost:8790 ")).toBe("http://localhost:8790");
    expect(runnerOrigin("https://runner.example.com/some/path")).toBe("https://runner.example.com");
    expect(runnerOrigin("")).toBeNull();
    expect(runnerOrigin("ftp://x")).toBeNull();
  });

  it("sends the page's cookies, and the Authorization header only if it was seen for that page", () => {
    const cookies = [{ name: "sid", value: "v", domain: ".example.com", hostOnly: false, path: "/", secure: true, httpOnly: true, expirationDate: 1800000000.5, storeId: "0", sameSite: "lax" }];
    const body = buildPayload("https://app.example.com", cookies, { origin: "https://app.example.com", value: "Bearer t" });
    expect(body).toEqual({
      origin: "https://app.example.com",
      cookies: [{ name: "sid", value: "v", domain: ".example.com", hostOnly: false, path: "/", secure: true, httpOnly: true, expirationDate: 1800000000.5 }],
      authorization: "Bearer t",
    });
    expect(buildPayload("https://app.example.com", cookies, { origin: "https://other.example.com", value: "Bearer t" })).not.toHaveProperty("authorization");
    expect(buildPayload("https://app.example.com", undefined, null)).toEqual({ origin: "https://app.example.com", cookies: [] });
  });

  it("says what was sent", () => {
    expect(sentSummary({ cookies: 6, authorization: true, target: "app.example.com:443" })).toBe("Sent 6 cookies and the Authorization header for app.example.com:443.");
    expect(sentSummary({ cookies: 1, authorization: false, target: "t:80" })).toBe("Sent 1 cookie for t:80.");
  });
});

describe("the extension's manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

  it("asks for no site up front: access is granted per site, when the person presses a button", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
    expect([...manifest.permissions].sort()).toEqual(["activeTab", "cookies", "storage", "webRequest"]);
  });

  it("names files that exist", () => {
    for (const f of [manifest.action.default_popup, manifest.background.service_worker, "popup.js", "popup.css", "payload.js"]) {
      expect(fs.existsSync(path.join(EXT, f)), f).toBe(true);
    }
  });
});
