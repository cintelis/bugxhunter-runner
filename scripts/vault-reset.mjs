#!/usr/bin/env node
// Break-glass: delete the key vault when every unlock factor is lost (passkey
// and recovery code). Must be run on the server, by someone with access to
// its files — that is the point: nothing on the network can do this.
//
//   npm run vault:reset                 # local; asks for confirmation
//   npm run vault:reset -- --yes        # no prompt
//   docker compose exec runner node server/dist/../../scripts/vault-reset.mjs --yes   (or: rm /data/vault.json)
//
// Afterwards the app is open again (no sign-in) and offers the setup wizard.
// Secrets that were in the vault are gone: add the SCX key again when
// recreating it. The backend notices the deletion without a restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const file = process.env.OPEN_RUNNER_VAULT_FILE ?? path.join(os.homedir(), ".config", "bugxhunter", "vault.json");
if (!fs.existsSync(file)) {
  console.log(`no vault at ${file} — nothing to reset`);
  process.exit(0);
}
if (!process.argv.includes("--yes")) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`Delete the vault at ${file}? Its secrets are unrecoverable. Type RESET to confirm: `, r));
  rl.close();
  if (answer.trim() !== "RESET") { console.log("aborted"); process.exit(1); }
}
fs.rmSync(file, { force: true });
console.log(`deleted ${file}. The app is open again; set up a new vault in the sidebar.`);
