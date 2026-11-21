/**
 * Raster fixer: answers one Send by editing the image with Codex's built-in image generation, then
 * compositing the result back ONLY inside the owner's mask, so nothing outside the marked area can drift.
 * The result becomes a candidate version; the owner accepts or rejects it in the studio.
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LoadedConfig } from "./config.ts";
import { createLogger, fmtDuration, type Logger } from "./log.ts";
import { blank, composite, flatten, keyOut, maskCoverage, maskFrom, readPng, resize, softenMask, writePng, type Img } from "./png.ts";
import { addCandidate, readNotes, writeAck, writeJob, writeReply, type Job, type Notes } from "./store.ts";

export interface FixOptions {
  /** Replace the generated edit instruction (Claude writes a better one after reading the sketch). */
  instruction?: string;
  /** Who is answering, recorded in the version history and ack. */
  agent: "claude" | "codex";
  /** Write the prompt and inputs but do not call Codex. */
  dryRun?: boolean;
  /** Studio log; by default a new one in the game's `.asset-studio/logs/`. */
  logger?: Logger;
  /** Override `fixTimeoutMin` from the config (ms). */
  timeoutMs?: number;
}

export interface FixResult {
  candidate: number | null;
  prompt: string;
  workDir: string;
}

const MASK_GROW = 18; // px: owners rarely paint to the exact edge of the thing they want gone
const MASK_FEATHER = 6; // px: soft seam between old and new pixels

export function buildInstruction(n: Notes, brief?: string): string {
  const lines: string[] = [];
  if (brief) lines.push(`Asset: ${brief}`);
  if (n.pins.length) {
    lines.push("Requested changes (numbered pins on the owner's sketch):");
    for (const p of n.pins) lines.push(`  ${p.n}. ${p.text}`);
  }
  if (n.notes.trim()) lines.push(`General note: ${n.notes.trim()}`);
  return lines.join("\n");
}

function styleText(cfg: LoadedConfig): string {
  if (!cfg.styleBlock) return "";
  return readFileSync(cfg.abs(cfg.styleBlock), "utf8")
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();
}

/** Red overlay on the masked area so the model sees where to change. */
function maskGuide(input: Img, mask: Float32Array): Img {
  const out = blank(input.width, input.height);
  for (let i = 0; i < mask.length; i++) {
    const p = i * 4, m = mask[i] > 0.5 ? 0.55 : 0;
    out.data[p] = Math.round(input.data[p] * (1 - m) + 255 * m);
    out.data[p + 1] = Math.round(input.data[p + 1] * (1 - m));
    out.data[p + 2] = Math.round(input.data[p + 2] * (1 - m));
    out.data[p + 3] = 255;
  }
  return out;
}

interface CodexRun {
  attempt: number;
  timeoutMs: number;
  /** Full codex stdout/stderr goes here (appended), for post-mortems. */
  logPath: string;
  L: Logger;
  onSpawn: (pid: number | undefined) => void;
  onHeartbeat: () => void;
}

const HEARTBEAT_MS = 30_000;

/** Kill a process and everything it started (codex is a .cmd shim on Windows: cmd.exe -> node -> ...). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGKILL"); // detached: own process group
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

function runCodex(cwd: string, images: string[], prompt: string, o: CodexRun): Promise<void> {
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  const args = ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", q(cwd), ...images.flatMap((i) => ["--image", q(i)])];
  const cmd = ["codex", ...args].join(" ");
  return new Promise((resolve, reject) => {
    const out = createWriteStream(o.logPath, { flags: "a" });
    out.write(`\n===== ${new Date().toISOString()} attempt ${o.attempt}: ${cmd}\n`);
    const t0 = Date.now();
    // One quoted command string: `codex` is a .cmd shim on Windows, which needs a shell.
    const child = spawn(cmd, { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    o.onSpawn(child.pid);
    o.L.info(`codex attempt ${o.attempt} started (pid ${child.pid}, timeout ${fmtDuration(o.timeoutMs)}, output: ${o.logPath})`);
    let tail = "";
    let bytes = 0;
    let lastOutput = Date.now();
    let timedOut = false;
    let settled = false;
    const keep = (b: Buffer) => {
      bytes += b.length;
      lastOutput = Date.now();
      out.write(b);
      tail = (tail + b.toString()).slice(-4000);
    };
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(beat);
      clearTimeout(timer);
      out.end(`\n===== ${new Date().toISOString()} attempt ${o.attempt} ended after ${fmtDuration(Date.now() - t0)}${err ? `: ${err.message}` : ""}\n`);
      if (err) reject(err);
      else resolve();
    };
    const beat = setInterval(() => {
      o.L.info(`codex attempt ${o.attempt} still running: ${fmtDuration(Date.now() - t0)}, ${bytes} bytes of output, last output ${fmtDuration(Date.now() - lastOutput)} ago`);
      o.onHeartbeat();
    }, HEARTBEAT_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      o.L.error(`codex attempt ${o.attempt} timed out after ${fmtDuration(o.timeoutMs)} (last output ${fmtDuration(Date.now() - lastOutput)} ago); killing pid ${child.pid}`);
      killTree(child.pid);
      // If the pipes never close (orphaned grandchild), do not wait for them.
      setTimeout(() => finish(new Error(`codex timed out after ${fmtDuration(o.timeoutMs)}; see ${o.logPath}`)), 5000).unref();
    }, o.timeoutMs);
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => finish(e));
    child.on("close", (code, signal) => {
      if (timedOut) return finish(new Error(`codex timed out after ${fmtDuration(o.timeoutMs)}; see ${o.logPath}`));
      o.L.info(`codex attempt ${o.attempt} exited ${code ?? signal} after ${fmtDuration(Date.now() - t0)} (${bytes} bytes of output)`);
      if (code === 0) finish();
      else finish(new Error(`codex exited ${code ?? signal}: ${tail.slice(-800)}`));
    });
    child.stdin.on("error", () => {}); // codex may exit before reading stdin; the close handler reports it
    child.stdin.end(prompt);
  });
}

export async function fixFeedback(cfg: LoadedConfig, folder: string, opts: FixOptions): Promise<FixResult> {
  const notes = readNotes(folder);
  const L = (opts.logger ?? createLogger(cfg.dataDir, { source: "fix", echo: false })).scope(notes.asset);
  const send = basename(folder);
  if (opts.dryRun) return prepareAndRun(cfg, folder, notes, opts, L, () => {});

  const t0 = Date.now();
  let stage = "starting";
  const job = (patch: Partial<Job>) => writeJob(folder, { owner: process.pid, ...patch });
  const setStage = (s: string, patch: Partial<Job> = {}) => {
    if (s !== stage) L.info(`${send}: ${s}`); // heartbeats and pid updates refresh job.json without a log line
    stage = s;
    job({ stage: s, ...patch });
  };
  job({ state: "running", stage, agent: opts.agent, startedAt: new Date().toISOString(), pid: undefined, attempt: undefined, endedAt: undefined });
  L.info(`${send}: fix started (agent ${opts.agent}, from v${notes.version}, ${notes.pins.length} pin(s), mask ${notes.hasMask ? "yes" : "no"})`);
  try {
    const r = await prepareAndRun(cfg, folder, notes, opts, L, setStage);
    job({ state: "done", stage: "done", candidate: r.candidate ?? undefined, endedAt: new Date().toISOString(), pid: undefined });
    L.info(`${send}: fix done, candidate v${r.candidate} after ${fmtDuration(Date.now() - t0)}`);
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    job({ state: "failed", error: msg.slice(0, 500), endedAt: new Date().toISOString(), pid: undefined });
    L.error(`${send}: fix FAILED while "${stage}" after ${fmtDuration(Date.now() - t0)}: ${msg}`);
    throw e;
  }
}

async function prepareAndRun(
  cfg: LoadedConfig,
  folder: string,
  notes: Notes,
  opts: FixOptions,
  L: Logger,
  setStage: (s: string, patch?: Partial<Job>) => void,
): Promise<FixResult> {
  const asset = cfg.byId.get(notes.asset);
  if (!asset) throw new Error(`unknown asset ${notes.asset}`);
  writeAck(folder, opts.agent);
  setStage("preparing inputs");

  const key = cfg.keyColor ?? [255, 0, 255];
  const work = join(folder, "work");
  mkdirSync(work, { recursive: true });
  const before = readPng(join(folder, "before.png"));
  const W = before.width, H = before.height;
  const input = flatten(before, key);
  writePng(join(work, "input.png"), input);

  let mask: Float32Array | null = null;
  const images = [join(work, "input.png")];
  if (existsSync(join(folder, "mask.png"))) {
    const raw = maskFrom(readPng(join(folder, "mask.png")), W, H);
    if (maskCoverage(raw) > 0.0005) {
      mask = softenMask(raw, W, H, MASK_GROW, MASK_FEATHER);
      writePng(join(work, "mask-guide.png"), maskGuide(input, raw));
      images.push(join(work, "mask-guide.png"));
    }
  }
  const refs = (cfg.styleRefs ?? []).map((r) => cfg.abs(r)).filter((r) => existsSync(r));
  images.push(...refs);

  const instruction = opts.instruction?.trim() || buildInstruction(notes, asset.brief);
  const hex = "#" + key.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
  const imagePrompt = [
    styleText(cfg),
    "",
    "EDIT TASK. The first attached image is the CURRENT asset. Reproduce it exactly: same character, pose, framing, size,",
    `outline, colours and print texture, on the same flat ${hex} background, ${W}x${H}.`,
    mask
      ? "The second attached image shows the area to change tinted RED. Change ONLY what is inside the red area; everything outside it must stay identical."
      : "Change only what the instruction below asks; keep everything else identical.",
    refs.length ? `The last ${refs.length} attached image(s) are STYLE REFERENCES only, not the subject.` : "",
    "",
    "THE ONLY CHANGE:",
    instruction,
  ]
    .filter((l) => l !== null)
    .join("\n");
  writeFileSync(join(work, "image-prompt.txt"), imagePrompt);

  const agentPrompt = [
    "You are an image-editing step in a game art pipeline.",
    `Use your built-in image generation tool (image_gen) with ALL ${images.length} attached images as visual inputs.`,
    "Use the full text of the file work/image-prompt.txt (in the current folder) unchanged as the image prompt.",
    "Do NOT draw with code, SVG, PIL or any script: the image must come from image generation.",
    "Save the generated image as work/edit-raw.png in the current folder (copy it from wherever generated images are stored).",
    "Do not create or change any other file. When done, print the saved path.",
  ].join("\n");
  writeFileSync(join(work, "agent-prompt.txt"), agentPrompt);

  if (opts.dryRun) return { candidate: null, prompt: imagePrompt, workDir: work };

  const rawPath = join(work, "edit-raw.png");
  const timeoutMs = opts.timeoutMs ?? (cfg.fixTimeoutMin ?? 10) * 60_000;
  const codex = (attempt: number) => {
    setStage(`codex image edit (attempt ${attempt})`, { attempt });
    return runCodex(folder, images, agentPrompt, {
      attempt,
      timeoutMs,
      logPath: join(work, "codex.log"),
      L,
      onSpawn: (pid) => setStage(`codex image edit (attempt ${attempt})`, { attempt, pid }),
      onHeartbeat: () => setStage(`codex image edit (attempt ${attempt})`, { attempt }),
    });
  };
  await codex(1);
  if (!existsSync(rawPath)) {
    // Seen in practice: Codex occasionally ends without copying the image. One retry is enough.
    L.warn("codex did not save work/edit-raw.png, retrying once");
    await codex(2);
  }
  if (!existsSync(rawPath)) throw new Error("codex finished twice but work/edit-raw.png is missing");

  setStage("compositing the edit into the mask", { pid: undefined });
  const edited = keyOut(resize(readPng(rawPath), W, H), key);
  const result = mask ? composite(before, edited, mask) : edited;
  const resultPath = join(work, "result.png");
  writePng(resultPath, result);

  const n = addCandidate(cfg, notes.asset, resultPath, {
    source: "fix",
    parent: notes.version,
    prompt: instruction,
    feedback: folder,
    agent: opts.agent,
  });
  writeReply(folder, {
    summary: `New version v${n} ready${mask ? " (changed only inside the marked area)" : ""}. Compare, then Accept or Reject.`,
    notes: notes.pins.map((p) => ({ pin: p.n, status: "fixed" as const, text: `Edited: ${p.text}` })),
    candidate: n,
  });
  return { candidate: n, prompt: imagePrompt, workDir: work };
}
