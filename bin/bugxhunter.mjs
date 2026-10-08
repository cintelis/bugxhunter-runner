#!/usr/bin/env node
/**
 * The `bugxhunter` command (npx bugxhunter / npm i -g bugxhunter).
 *
 *   bugxhunter                      run the runner here, UI on http://localhost:8790
 *   bugxhunter [--port N] [--dir P] [--no-open]
 *   bugxhunter docker [--slim|--full] the sandboxed stack: writes ~/.config/bugxhunter/docker
 *                                   (compose file + .env secrets), pulls the signed images
 *                                   matching this version, starts it, opens the UI.
 *                                   With args, runs `docker compose <args>` there (down, logs…).
 *   bugxhunter vault reset           break-glass: delete the key vault (see scripts/vault-reset.mjs)
 *
 * Local mode runs the agent on this machine: OpenCode is a dependency of this
 * package, so nothing else needs installing. Its binary is found by putting
 * this package's node_modules/.bin on PATH before the server starts.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const CONFIG_DIR = path.join(os.homedir(), ".config", "bugxhunter");

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };

if (flag("--version") || flag("-v")) { console.log(pkg.version); process.exit(0); }
if (flag("--help") || flag("-h")) {
  console.log(`bugxhunter ${pkg.version}

  bugxhunter                       run the runner here (agent on this machine), UI on http://localhost:8790
    --port <n>                     UI port (default 8790, or PORT)
    --dir <path>                   default project folder (default: the current folder)
    --no-open                      don't open the browser
  bugxhunter docker                the sandboxed stack via Docker (writes ~/.config/bugxhunter/docker, pulls the
                                   signed images for v${pkg.version}, starts, opens the UI)
    --slim                         the agent image without the scan toolchain: half the download, code review only
    --full                         back to the full image (the default)
  bugxhunter docker <args>         docker compose <args> in that folder, e.g. down, logs -f, ps
  bugxhunter vault reset           delete the key vault when every unlock factor is lost

Docs: https://github.com/cintelis/bugxhunter-runner`);
  process.exit(0);
}

const cmd = args[0];
if (cmd === "docker") await dockerMode(args.slice(1));
else if (cmd === "vault" && args[1] === "reset") await vaultReset(args.slice(2));
else if (cmd && !cmd.startsWith("-")) { console.error(`unknown command: ${cmd} (try --help)`); process.exit(2); }
else await localMode();

// --- local mode -----------------------------------------------------------------------

async function localMode() {
  const port = Number(opt("--port") ?? process.env.PORT ?? 8790);
  const dir = path.resolve(opt("--dir") ?? process.env.OPEN_RUNNER_DIR ?? process.cwd());
  const open = !flag("--no-open");

  // Settings: ~/.config/bugxhunter/.env, then ./.env (both optional; never printed).
  const { default: dotenv } = await import("dotenv");
  for (const f of [path.join(CONFIG_DIR, ".env"), path.join(process.cwd(), ".env")]) {
    if (fs.existsSync(f)) dotenv.config({ path: f });
  }
  process.env.NODE_ENV ??= "production";
  process.env.PORT = String(port);
  process.env.OPEN_RUNNER_DIR = dir;

  // OpenCode's binary lives in this package's dependencies.
  const bins = [path.join(ROOT, "node_modules", ".bin"), path.resolve(ROOT, "..", ".bin")];
  process.env.PATH = [...bins.filter((b) => fs.existsSync(b)), process.env.PATH ?? ""].join(path.delimiter);
  if (!hasOpencode()) {
    console.error("OpenCode was not found. It is installed with this package; try `npm i -g bugxhunter` again, or `npm i -g opencode-ai`.");
    process.exit(1);
  }

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) { console.error(`Node ${process.versions.node} is too old: BugXHunter needs Node 22+.`); process.exit(1); }

  await import(pathToFileURL(path.join(ROOT, "server", "dist", "index.js")).href);
  if (open) {
    const url = `http://localhost:${port}`;
    if (await waitFor(`http://127.0.0.1:${port}/api/health`, 15_000)) openBrowser(url);
  }
}

/** Is `opencode` on PATH? A file check, since Windows .cmd shims cannot be spawned without a shell. */
function hasOpencode() {
  const names = process.platform === "win32" ? ["opencode.cmd", "opencode.exe", "opencode"] : ["opencode"];
  return (process.env.PATH ?? "").split(path.delimiter).some((d) => d && names.some((n) => fs.existsSync(path.join(d, n))));
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function openBrowser(url) {
  const [bin, a] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(bin, a, { stdio: "ignore", detached: true }).unref(); } catch { /* headless: the URL is printed by the server */ }
}

// --- docker mode ----------------------------------------------------------------------

async function dockerMode(rest) {
  const slim = flag("--slim"), full = flag("--full");
  rest = rest.filter((a) => a !== "--slim" && a !== "--full");
  const dir = path.join(CONFIG_DIR, "docker");
  if (spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).error) {
    console.error("Docker is not installed or not running. Install Docker Desktop (https://docs.docker.com/get-docker/) and try again.");
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  // The compose file of this version, verbatim: the images it names are the
  // signed release images; BXH_VERSION in .env pins them to this version.
  fs.copyFileSync(path.join(ROOT, "docker-compose.yml"), path.join(dir, "docker-compose.yml"));
  const envFile = path.join(dir, ".env");
  const vals = new Map();
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) vals.set(m[1], m[2]);
    }
  }
  const fresh = !vals.size;
  if (!vals.get("OPEN_RUNNER_SECRET")) vals.set("OPEN_RUNNER_SECRET", crypto.randomBytes(32).toString("base64url"));
  if (!vals.get("SCX_PROXY_TOKEN")) vals.set("SCX_PROXY_TOKEN", crypto.randomBytes(32).toString("base64url"));
  vals.set("BXH_VERSION", `v${pkg.version}`);
  // The agent flavour sticks until changed: `--slim` once, then plain `docker` keeps it.
  if (slim) vals.set("BXH_AGENT_FLAVOR", "-slim");
  if (full) vals.delete("BXH_AGENT_FLAVOR");
  const flavor = vals.get("BXH_AGENT_FLAVOR") ?? "";
  fs.writeFileSync(envFile, [...vals].map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  console.log(`${fresh ? "Created" : "Updated"} ${dir} (compose file + .env; secrets are random and never printed)`);

  const compose = (a) => spawnSync("docker", ["compose", ...a], { cwd: dir, stdio: "inherit" }).status ?? 1;
  if (rest.length) process.exit(compose(rest));
  console.log(`Pulling the signed images for v${pkg.version}${flavor ? " (slim agent: no scan toolchain)" : " (the agent image is large the first time; --slim halves it)"}…`);
  if (compose(["pull"]) !== 0) process.exit(1);
  if (compose(["up", "-d"]) !== 0) process.exit(1);
  const port = vals.get("OPEN_RUNNER_PORT") ?? "8790";
  const url = `http://localhost:${port}`;
  console.log(`BugXHunter is starting at ${url}. Set up the vault in the sidebar, add your model key, connect GitHub.`);
  console.log(`Later: bugxhunter docker logs -f · bugxhunter docker down · re-run after \`npm i -g bugxhunter@latest\` to upgrade.`);
  if (await waitFor(`http://127.0.0.1:${port}/api/health`, 60_000)) openBrowser(url);
}

// --- vault reset ----------------------------------------------------------------------

async function vaultReset(rest) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "vault-reset.mjs"), ...rest], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
