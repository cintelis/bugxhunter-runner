#!/usr/bin/env node
// Assembles the publishable `bugxhunter` npm package in dist/npm from the
// built workspaces (run `npm run build` first):
//
//   bin/bugxhunter.mjs          the command
//   server/dist, web/dist       the compiled runner (same relative layout as the
//                               repo, so server/dist resolves web/dist as usual)
//   scripts/vault-reset.mjs     `bugxhunter vault reset`
//   docker-compose.yml          `bugxhunter docker`
//   .env.example, README, LICENSE, SECURITY
//
// Its package.json is generated: the server's runtime dependencies plus
// opencode-ai (the agent binary, so Node is the only prerequisite). Workspaces,
// dev dependencies and scripts stay here. `npm publish ./dist/npm` publishes it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "npm");
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const rootPkg = read("package.json");
const serverPkg = read("server/package.json");

for (const must of ["server/dist/index.js", "web/dist/index.html"]) {
  if (!fs.existsSync(path.join(root, must))) { console.error(`missing ${must}: run \`npm run build\` first`); process.exit(1); }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const copy = (from, to = from) => fs.cpSync(path.join(root, from), path.join(out, to), { recursive: true });
copy("bin");
copy("server/dist");
copy("web/dist");
fs.mkdirSync(path.join(out, "scripts"));
copy("scripts/vault-reset.mjs");
for (const f of ["docker-compose.yml", ".env.example", "README.md", "LICENSE", "SECURITY.md"]) copy(f);
// Source maps are for debugging the repo, not for every install.
for (const f of fs.readdirSync(path.join(out, "server", "dist"))) if (f.endsWith(".map")) fs.rmSync(path.join(out, "server", "dist", f));

// The agent binary, pinned to the version this release was built against.
const opencodeVersion = read("node_modules/opencode-ai/package.json").version;

const pkg = {
  name: "bugxhunter",
  version: rootPkg.version,
  description: "BugXHunter: an AI security-testing agent with a sandboxed runner, a passkey-sealed key vault and read-only GitHub access. `npx bugxhunter` runs it on your machine.",
  license: rootPkg.license,
  homepage: rootPkg.homepage,
  // npm's canonical form; anything else is "auto-corrected" with a warning at publish time.
  repository: { type: "git", url: "git+https://github.com/cintelis/bugxhunter-runner.git" },
  bugs: { url: "https://github.com/cintelis/bugxhunter-runner/issues" },
  keywords: ["security", "pentest", "bug-bounty", "ai-agent", "opencode", "vulnerability-scanner", "code-review"],
  type: "module",
  bin: { bugxhunter: "bin/bugxhunter.mjs" },
  engines: { node: ">=22" },
  dependencies: { ...serverPkg.dependencies, "opencode-ai": `^${opencodeVersion}` },
  publishConfig: { access: "public" },
};
fs.writeFileSync(path.join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log(`packed bugxhunter@${pkg.version} into ${path.relative(root, out)} (opencode-ai ^${opencodeVersion})`);
