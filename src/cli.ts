/**
 * asset-studio <command> [--config <file>]
 *   dev                         serve the studio page (http://127.0.0.1:5180 by default)
 *   watch                       print "NEW FEEDBACK: <folder>" for every unanswered Send (Claude mode)
 *   pending                     list unanswered Sends
 *   accept|reject <assetId>     same as the page buttons for the current candidate
 *   request <assetId> --note <text> [--rect x0,y0,x1,y1]... [--ellipse x0,y0,x1,y1]...
 *                               file a Send from the command line (agent batch fixes); prints the folder
 *   fix <folder> [--instruction <text> | --instruction-file <file>] [--agent claude|codex] [--dry-run]
 *                               edit the image for one Send with Codex image generation, masked composite,
 *                               store a candidate version and write reply.json
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { fixFeedback } from "./fixer.ts";
import { startServer } from "./server.ts";
import { PNG } from "pngjs";
import { blank, readPng, type Img } from "./png.ts";
import { getMeta, makeCurrent, pendingFeedback, rejectCandidate, versionPath, writeAck, writeFeedback } from "./store.ts";

function toDataUrl(img: Img): string {
  const p = new PNG({ width: img.width, height: img.height });
  img.data.copy(p.data);
  return "data:image/png;base64," + PNG.sync.write(p).toString("base64");
}

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

  if (cmd === "accept" || cmd === "reject") {
    // accept|reject <assetId>: same as the page buttons (accept writes the candidate to the game file)
    if (!pos) throw new Error(`usage: ${cmd} <assetId>`);
    const meta = getMeta(cfg, pos);
    if (meta.candidate == null) throw new Error(`${pos}: no candidate`);
    if (cmd === "accept") {
      const n = meta.candidate;
      makeCurrent(cfg, pos, n);
      console.log(`${pos}: v${n} is current, written to ${cfg.byId.get(pos)!.file}`);
    } else {
      rejectCandidate(cfg, pos);
      console.log(`${pos}: candidate rejected`);
    }
    return;
  }

  if (cmd === "request") {
    // Agent-side Send without the page: request <assetId> --note <text> [--rect x0,y0,x1,y1]... [--ellipse x0,y0,x1,y1]...
    if (!pos) throw new Error("usage: request <assetId> --note <text> [--rect x0,y0,x1,y1] [--ellipse x0,y0,x1,y1]");
    const meta = getMeta(cfg, pos);
    const cur = readPng(versionPath(cfg, pos, meta.current));
    const shapes = process.argv.flatMap((a, i) => (a === "--rect" || a === "--ellipse" ? [{ kind: a.slice(2), box: process.argv[i + 1].split(",").map(Number) }] : []));
    let mask: string | null = null;
    if (shapes.length) {
      const m = blank(cur.width, cur.height);
      for (let y = 0; y < cur.height; y++)
        for (let x = 0; x < cur.width; x++) {
          const hit = shapes.some(({ kind, box: [x0, y0, x1, y1] }) => {
            if (kind === "rect") return x >= x0 && x <= x1 && y >= y0 && y <= y1;
            const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
            return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
          });
          if (hit) m.data.fill(255, (y * cur.width + x) * 4, (y * cur.width + x) * 4 + 4);
        }
      mask = toDataUrl(m);
    }
    const dir = writeFeedback(cfg, { asset: pos, pins: [], notes: arg("note") ?? "", sketch: toDataUrl(cur), mask, photos: [] });
    console.log(dir);
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
