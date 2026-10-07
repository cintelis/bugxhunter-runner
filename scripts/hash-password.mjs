#!/usr/bin/env node
// Prints an OPEN_RUNNER_PASSWORD_HASH line for .env, so the login password is
// never stored in the clear. Prompts without echo; or pass the password as the
// first argument (it then lands in your shell history — prefer the prompt).
//
//   node scripts/hash-password.mjs
import crypto from "node:crypto";
import readline from "node:readline";

const N = 1 << 15, r = 8, p = 1; // ~32 MB, tens of ms: fine for a login

async function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const mute = () => { rl._writeToOutput = () => {}; }; // hide the typed characters
  return new Promise((resolve) => {
    rl.question(q, (a) => { rl.close(); process.stdout.write("\n"); resolve(a); });
    mute();
  });
}

const password = process.argv[2] ?? await prompt("Login password: ");
if (!password) { console.error("empty password"); process.exit(1); }
if (!process.argv[2]) {
  const again = await prompt("Again: ");
  if (again !== password) { console.error("passwords differ"); process.exit(1); }
}
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 32, { N, r, p });
console.log(`OPEN_RUNNER_PASSWORD_HASH=scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`);
console.log("# put that line in .env and remove OPEN_RUNNER_PASSWORD");
