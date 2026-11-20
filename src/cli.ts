/**
 * asset-studio <command> [--config <file>]
 *   dev                         serve the studio page (http://127.0.0.1:5180 by default)
 *   watch                       print "NEW FEEDBACK: <folder>" for every unanswered Send (Claude mode)
 *   pending                     list unanswered Sends
 *   fix <folder> [--instruction <text> | --instruction-file <file>] [--agent claude|codex] [--dry-run]
 *                               edit the image for one Send with Codex image generation, masked composite,
 *                               store a candidate version and write reply.json
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { fixFeedback } from "./fixer.ts";
import { startServer } from "./server.ts";
import { pendingFeedback, writeAck } from "./store.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const [cmd, pos] = process.argv.slice(2);
  const cfgPath = arg("config") ?? resolve(process.cwd(), "asset-studio.config.mjs");
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?|^ \* ?/gm, ""));
    return;
  }
  const cfg = await loadConfig(cfgPath);

  if (cmd === "dev") return startServer(cfg);

  if (cmd === "pending") {
    for (const f of pendingFeedback(cfg)) console.log(f);
    return;
  }

  if (cmd === "watch") {
    const seen = new Set<string>();
    console.log(`watching ${cfg.dataDir} (Ctrl+C to stop)`);
    const tick = () => {
      for (const f of pendingFeedback(cfg)) {
        if (seen.has(f)) continue;
        seen.add(f);
        if (!existsSync(resolve(f, "ack.json"))) writeAck(f, "watcher");
        console.log(`NEW FEEDBACK: ${f}`);
      }
    };
    tick();
    setInterval(tick, 2000);
    return;
  }

  if (cmd === "fix") {
    if (!pos) throw new Error("usage: fix <feedback folder>");
    const file = arg("instruction-file");
    const instruction = file ? readFileSync(file, "utf8") : arg("instruction");
    const agent = (arg("agent") ?? "claude") as "claude" | "codex";
    const r = await fixFeedback(cfg, resolve(pos), { instruction, agent, dryRun: process.argv.includes("--dry-run"), log: console.log });
    console.log(r.candidate ? `candidate v${r.candidate}  (work: ${r.workDir})` : `dry run, prompt in ${r.workDir}`);
    return;
  }

  throw new Error(`unknown command: ${cmd}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
