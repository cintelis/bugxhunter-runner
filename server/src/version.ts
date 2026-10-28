// The release this runner was built from: the root package.json, which sits two levels up from
// both server/src (dev) and server/dist (Docker image and npm package alike).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function readVersion(file = path.resolve(here, "../../package.json")): string {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")).version;
    return typeof v === "string" && v ? v : "unknown";
  } catch {
    return "unknown";
  }
}

export const VERSION = readVersion();
