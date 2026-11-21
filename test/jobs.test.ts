/**
 * Job tracking, logging and the fix timeout, with a fake `codex` on PATH:
 *   note contains "hang" -> never exits (the stuck-queue case)
 *   otherwise            -> copies work/input.png to work/edit-raw.png (a perfect "edit")
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { fixFeedback } from "../src/fixer.ts";
import { createLogger, tailLog } from "../src/log.ts";
import { blank, writePng } from "../src/png.ts";
import { FixQueue } from "../src/server.ts";
import { getMeta, isInterrupted, jobLabel, readJob, writeFeedback, writeJob } from "../src/store.ts";

beforeAll(() => {
  const bin = mkdtempSync(join(tmpdir(), "fake-codex-"));
  writeFileSync(
    join(bin, "fake-codex.mjs"),
    `import { copyFileSync, readFileSync } from "node:fs";
const notes = readFileSync("notes.json", "utf8");
process.stdin.resume();
console.log("fake codex: started");
if (notes.includes("hang")) setInterval(() => {}, 1e9);
else { copyFileSync("work/input.png", "work/edit-raw.png"); console.log("saved work/edit-raw.png"); process.exit(0); }
`,
  );
  writeFileSync(join(bin, "codex.cmd"), `@node "%~dp0fake-codex.mjs" %*\r\n`);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec node "$(dirname "$0")/fake-codex.mjs" "$@"\n`);
  chmodSync(join(bin, "codex"), 0o755);
  process.env.PATH = bin + delimiter + process.env.PATH;
});

async function project(extra = "") {
  const dir = mkdtempSync(join(tmpdir(), "as-jobs-"));
  const im = blank(8, 8);
  im.data.fill(200);
  writePng(join(dir, "a.png"), im);
  writeFileSync(
    join(dir, "asset-studio.config.mjs"),
    `export default { name: "t", agent: "codex", ${extra} groups: [{ id: "g", label: "G", assets: [{ id: "unit/a", label: "A", file: "a.png" }] }] };`,
  );
  const cfg = await loadConfig(join(dir, "asset-studio.config.mjs"));
  const img = "data:image/png;base64," + readFileSync(join(dir, "a.png")).toString("base64");
  const send = (note: string) => writeFeedback(cfg, { asset: "unit/a", pins: [], notes: note, sketch: img, mask: null, photos: [] });
  return { dir, cfg, send };
}

const waitFor = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe("logging", () => {
  it("appends tagged lines to .asset-studio/logs/studio.log", async () => {
    const { cfg } = await project();
    const L = createLogger(cfg.dataDir, { source: "test", echo: false });
    L.scope("unit/a").info("hello");
    L.error("multi\nline");
    const t = tailLog(cfg.dataDir, 10);
    expect(t).toMatch(/INFO  test#\d+ \[unit\/a\] hello/);
    expect(t).toContain("multi ⏎ line");
  });
});

describe("job record", () => {
  it("labels running jobs with stage and time, and spots interrupted ones", async () => {
    const { send } = await project();
    const f = send("x");
    writeJob(f, { state: "running", stage: "codex image edit (attempt 1)", agent: "codex", owner: process.pid, startedAt: new Date(Date.now() - 95_000).toISOString() });
    expect(jobLabel(readJob(f))).toBe("codex: codex image edit (attempt 1) · 1m 35s");
    const dead = writeJob(f, { owner: 999_999_99 });
    expect(isInterrupted(dead)).toBe(true);
    expect(jobLabel(dead)).toMatch(/^Interrupted/);
  });
});

describe("fix with a fake codex", () => {
  it("succeeds: candidate stored, job done, codex output kept", async () => {
    const { cfg, send } = await project();
    const f = send("make it nicer");
    const r = await fixFeedback(cfg, f, { agent: "codex", logger: createLogger(cfg.dataDir, { echo: false }) });
    expect(r.candidate).toBe(2);
    expect(readJob(f)).toMatchObject({ state: "done", candidate: 2 });
    expect(readFileSync(join(f, "work", "codex.log"), "utf8")).toContain("fake codex: started");
    expect(tailLog(cfg.dataDir, 50)).toContain("fix done, candidate v2");
  }, 20_000);

  it("times out a hanging codex, kills it and marks the job failed", async () => {
    const { cfg, send } = await project();
    const f = send("hang please");
    await expect(fixFeedback(cfg, f, { agent: "codex", timeoutMs: 1500, logger: createLogger(cfg.dataDir, { echo: false }) })).rejects.toThrow(/timed out/);
    const j = readJob(f)!;
    expect(j.state).toBe("failed");
    expect(j.error).toMatch(/timed out/);
    expect(tailLog(cfg.dataDir, 50)).toMatch(/fix FAILED while "codex image edit \(attempt 1\)"/);
  }, 20_000);

  it("queue: a hanging job no longer blocks the Sends behind it", async () => {
    const { cfg, send } = await project("fixTimeoutMin: 0.025,"); // 1.5 s
    const q = new FixQueue(cfg, createLogger(cfg.dataDir, { echo: false }));
    const stuck = send("hang");
    await new Promise((r) => setTimeout(r, 1100)); // distinct folder stamps (second resolution)
    const next = send("fine");
    q.push(stuck, "unit/a");
    q.push(next, "unit/a");
    expect(readJob(next)?.state).toBe("queued");
    expect(q.position(next)).toBe(2);
    await waitFor(() => existsSync(join(next, "reply.json")), 15_000);
    expect(JSON.parse(readFileSync(join(stuck, "reply.json"), "utf8")).summary).toMatch(/^Fix failed: codex timed out/);
    expect(readJob(next)?.state).toBe("done");
    expect(getMeta(cfg, "unit/a").candidate).toBe(2);
  }, 30_000);
});
