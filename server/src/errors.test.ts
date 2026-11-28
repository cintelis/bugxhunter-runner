import { describe, expect, it } from "vitest";
import { permissionGone } from "./errors.js";

describe("permissionGone", () => {
  it("recognises OpenCode's answer for a request it no longer holds", () => {
    expect(permissionGone({ _tag: "PermissionNotFoundError", requestID: "per_1", message: "Permission request not found: per_1" })).toBe(true);
    expect(permissionGone("Permission request not found: per_1")).toBe(true);
  });

  it("is not fooled by another error, or by none", () => {
    expect(permissionGone(undefined)).toBe(false);
    expect(permissionGone({ name: "BadRequest", message: "response required" })).toBe(false);
  });
});
