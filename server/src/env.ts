/**
 * Loads the repo-root .env before any other module reads process.env.
 *
 * Must be the first import in index.ts: ES module imports are evaluated in
 * order, and auth.ts, opencode.ts and audit.ts read their settings at import
 * time. Loading dotenv later (as index.ts once did) meant a `.env` password or
 * model never applied in local mode.
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Both src/ (tsx) and dist/ (compiled) sit two levels below the repo root.
dotenv.config({ path: path.resolve(here, "../../.env") });
