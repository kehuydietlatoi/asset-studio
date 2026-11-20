#!/usr/bin/env node
// Thin launcher: runs the TypeScript CLI through tsx so games need no build step.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const cli = join(root, "src", "cli.ts");
const r = spawnSync(process.execPath, [tsx, cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
