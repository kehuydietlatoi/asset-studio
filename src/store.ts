/**
 * Studio data on disk, inside the game repo at `.asset-studio/`:
 *   assets/<dir>/meta.json, v<n>.png   version history + review status of one asset
 *   feedback/<dir>/<stamp>/            one Send: notes.json, sketch.png, mask.png?, photos/, before.png,
 *                                      status.json (written last = complete), ack.json, reply.json
 * <dir> is the asset id with "/" replaced by "__".
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cellSize, gridOf, type AssetDef, type LoadedConfig } from "./config.ts";
import { fmtDuration } from "./log.ts";
import { crop, readPng, writePng, type Img } from "./png.ts";

/** `brief`: the asset has a brief but no image yet (Generate makes the first one). */
export type ReviewStatus = "brief" | "generated" | "in_review" | "needs_fix" | "approved";

export interface VersionInfo {
  n: number;
  at: string;
  source: "import" | "fix" | "manual" | "generate";
  parent?: number;
  prompt?: string;
  feedback?: string;
  agent?: string;
}

export interface Meta {
  id: string;
  status: ReviewStatus;
  /** 0 = no image yet (status `brief`). */
  current: number;
  candidate: number | null;
  versions: VersionInfo[];
}

export interface Pin {
  n: number;
  x: number;
  y: number;
  text: string;
}

export interface Notes {
  asset: string;
  version: number;
  imageSize: [number, number];
  pins: Pin[];
  notes: string;
  hasMask: boolean;
  /** `generate`: draw a new image from the brief (no before.png); default `edit`: change the current image. */
  mode?: "edit" | "generate";
}

export interface Reply {
  summary: string;
  notes: { pin: number | null; status: "fixed" | "question" | "wont"; text: string }[];
  candidate?: number;
}

export class StoreError extends Error {}

export const dirOf = (id: string) => id.replace(/\//g, "__");
const now = () => new Date().toISOString();
const readJson = <T>(p: string): T | null => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null);
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2));

export function assetDir(cfg: LoadedConfig, id: string): string {
  return join(cfg.dataDir, "assets", dirOf(id));
}

export function versionPath(cfg: LoadedConfig, id: string, n: number): string {
  return join(assetDir(cfg, id), `v${n}.png`);
}

/**
 * Meta of an asset; the first call imports the configured file as v1. An asset whose file does not exist yet gets
 * status `brief` and no version: Generate draws its first image. If the file appears later (made outside the
 * studio), the next call imports it.
 */
export function getMeta(cfg: LoadedConfig, id: string): Meta {
  const a = cfg.byId.get(id);
  if (!a) throw new StoreError(`unknown asset ${id}`);
  const dir = assetDir(cfg, id);
  const metaPath = join(dir, "meta.json");
  const meta = readJson<Meta>(metaPath);
  const src = cfg.abs(a.file);
  if (meta && !(meta.current === 0 && !meta.versions.length && existsSync(src))) return meta;
  mkdirSync(dir, { recursive: true });
  if (!existsSync(src)) {
    const brief: Meta = { id, status: "brief", current: 0, candidate: null, versions: [] };
    writeJson(metaPath, brief);
    return brief;
  }
  copyFileSync(src, join(dir, "v1.png"));
  const fresh: Meta = { id, status: "generated", current: 1, candidate: null, versions: [{ n: 1, at: now(), source: "import" }] };
  writeJson(metaPath, fresh);
  return fresh;
}

/** Pixel size of the image Generate makes for an asset (the whole sheet for a variant set). */
export function sheetSize(a: Pick<AssetDef, "variants" | "size">): [number, number] {
  const [cw, ch] = cellSize(a), [cols, rows] = gridOf(a.variants);
  return [cw * cols, ch * rows];
}

/** The variants of a sheet, left to right, top to bottom (cell size = sheet size / grid). */
export function splitVariants(sheet: Img, variants: number): Img[] {
  const [cols, rows] = gridOf(variants);
  const cw = Math.floor(sheet.width / cols), ch = Math.floor(sheet.height / rows);
  return Array.from({ length: variants }, (_, k) => crop(sheet, (k % cols) * cw, Math.floor(k / cols) * ch, cw, ch));
}

/** Game files of the variants of a set: `burn_flame.png` -> `burn_flame.1.png`, `burn_flame.2.png`, ... */
export function variantFiles(a: Pick<AssetDef, "file" | "variants">): string[] {
  const stem = a.file.replace(/\.png$/i, "");
  return Array.from({ length: a.variants ?? 1 }, (_, k) => `${stem}.${k + 1}.png`);
}

function saveMeta(cfg: LoadedConfig, meta: Meta): void {
  writeJson(join(assetDir(cfg, meta.id), "meta.json"), meta);
}

/** Store a new version as the candidate (shown as "after" until accepted or rejected). Returns its number. */
export function addCandidate(cfg: LoadedConfig, id: string, pngPath: string, info: Omit<VersionInfo, "n" | "at">): number {
  const meta = getMeta(cfg, id);
  const n = Math.max(0, ...meta.versions.map((v) => v.n)) + 1;
  copyFileSync(pngPath, versionPath(cfg, id, n));
  meta.versions.push({ n, at: now(), ...info });
  meta.candidate = n;
  meta.status = "in_review";
  saveMeta(cfg, meta);
  return n;
}

/** Make version n current and write it to the game's asset file (and, for a variant set, each variant's file). */
export function makeCurrent(cfg: LoadedConfig, id: string, n: number): Meta {
  const meta = getMeta(cfg, id);
  if (!meta.versions.some((v) => v.n === n)) throw new StoreError(`no version ${n}`);
  const a = cfg.byId.get(id)!;
  mkdirSync(dirname(cfg.abs(a.file)), { recursive: true });
  copyFileSync(versionPath(cfg, id, n), cfg.abs(a.file));
  if ((a.variants ?? 1) > 1) {
    const parts = splitVariants(readPng(versionPath(cfg, id, n)), a.variants!);
    variantFiles(a).forEach((f, k) => writePng(cfg.abs(f), parts[k]));
  }
  meta.current = n;
  if (meta.candidate === n) meta.candidate = null;
  saveMeta(cfg, meta);
  return meta;
}

export function rejectCandidate(cfg: LoadedConfig, id: string): Meta {
  const meta = getMeta(cfg, id);
  meta.candidate = null;
  if (meta.current === 0) meta.status = "brief"; // still nothing accepted
  saveMeta(cfg, meta);
  return meta;
}

export function setStatus(cfg: LoadedConfig, id: string, status: ReviewStatus): Meta {
  const meta = getMeta(cfg, id);
  meta.status = status;
  saveMeta(cfg, meta);
  return meta;
}

// ---------------------------------------------------------------- feedback

export interface SendPayload {
  asset: string;
  pins: Pin[];
  notes: string;
  sketch: string; // data URL (PNG): stage + mark-up
  mask: string | null; // data URL (PNG): white = area to change, image coordinates
  photos: string[]; // data URLs
}

const MAX_PHOTOS = 6;
const MAX_IMAGE = 8 * 1024 * 1024;

function decodeDataUrl(url: string, what: string): Buffer {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!m) throw new StoreError(`${what}: not an image data URL`);
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_IMAGE) throw new StoreError(`${what}: larger than 8 MB`);
  return buf;
}

export function feedbackRoot(cfg: LoadedConfig): string {
  return join(cfg.dataDir, "feedback");
}

/** Write one Send. Every path is built here; nothing from the request is used as a path. */
export function writeFeedback(cfg: LoadedConfig, p: SendPayload): string {
  if (!cfg.byId.has(p.asset)) throw new StoreError("unknown asset");
  if (!Array.isArray(p.pins) || !Array.isArray(p.photos)) throw new StoreError("bad payload");
  if (p.photos.length > MAX_PHOTOS) throw new StoreError(`at most ${MAX_PHOTOS} photos`);
  if (!p.pins.length && !p.notes?.trim()) throw new StoreError("add at least one pin or a note");
  const meta = getMeta(cfg, p.asset);
  if (meta.current === 0) throw new StoreError("this asset has no image yet: Generate it first");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  let dir = join(feedbackRoot(cfg), dirOf(p.asset), stamp);
  for (let i = 2; existsSync(dir); i++) dir = join(feedbackRoot(cfg), dirOf(p.asset), `${stamp}-${i}`);
  mkdirSync(join(dir, "photos"), { recursive: true });
  writeFileSync(join(dir, "sketch.png"), decodeDataUrl(p.sketch, "sketch"));
  if (p.mask) writeFileSync(join(dir, "mask.png"), decodeDataUrl(p.mask, "mask"));
  p.photos.forEach((ph, i) => writeFileSync(join(dir, "photos", `photo-${i + 1}.png`), decodeDataUrl(ph, `photo ${i + 1}`)));
  copyFileSync(versionPath(cfg, p.asset, meta.current), join(dir, "before.png"));
  const pins = p.pins.map((pin, i) => ({ n: i + 1, x: Math.round(+pin.x), y: Math.round(+pin.y), text: String(pin.text ?? "").slice(0, 500) }));
  const { width, height } = readPng(join(dir, "before.png"));
  const notes: Notes = { asset: p.asset, version: meta.current, imageSize: [width, height], pins, notes: String(p.notes ?? "").slice(0, 2000), hasMask: !!p.mask };
  writeJson(join(dir, "notes.json"), notes);
  writeJson(join(dir, "status.json"), { complete: true, at: now() });
  setStatus(cfg, p.asset, "needs_fix");
  return dir;
}

/**
 * File a Generate request for one asset: a Send folder with `mode: "generate"` and no before.png. It goes through
 * the same queue, watcher, job tracking and reply as an edit; the fixer draws a new image from the brief (plus the
 * optional note) and stores it as a candidate.
 */
export function writeGenerateRequest(cfg: LoadedConfig, id: string, note = ""): string {
  const a = cfg.byId.get(id);
  if (!a) throw new StoreError("unknown asset");
  if (!a.brief?.trim() && !note.trim()) throw new StoreError(`${id} has no brief: add one in the config or write a note`);
  const meta = getMeta(cfg, id);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  let dir = join(feedbackRoot(cfg), dirOf(id), stamp);
  for (let i = 2; existsSync(dir); i++) dir = join(feedbackRoot(cfg), dirOf(id), `${stamp}-${i}`);
  mkdirSync(dir, { recursive: true });
  const notes: Notes = { asset: id, version: meta.current, imageSize: sheetSize(a), pins: [], notes: String(note).slice(0, 2000), hasMask: false, mode: "generate" };
  writeJson(join(dir, "notes.json"), notes);
  writeJson(join(dir, "status.json"), { complete: true, at: now() });
  return dir;
}

export interface FeedbackState {
  folder: string;
  ack: { by: string; at: string } | null;
  reply: Reply | null;
}

function foldersOf(cfg: LoadedConfig, id: string): string[] {
  const base = join(feedbackRoot(cfg), dirOf(id));
  if (!existsSync(base)) return [];
  return readdirSync(base).sort().map((f) => join(base, f));
}

export function latestFeedback(cfg: LoadedConfig, id: string): FeedbackState | null {
  const all = foldersOf(cfg, id);
  const dir = all[all.length - 1];
  if (!dir) return null;
  return { folder: dir, ack: readJson(join(dir, "ack.json")), reply: readJson(join(dir, "reply.json")) };
}

/** Complete Sends that nobody has answered yet, oldest first. */
export function pendingFeedback(cfg: LoadedConfig): string[] {
  const out: string[] = [];
  for (const id of cfg.byId.keys()) {
    for (const dir of foldersOf(cfg, id)) {
      if (existsSync(join(dir, "status.json")) && !existsSync(join(dir, "reply.json"))) out.push(dir);
    }
  }
  return out.sort((a, b) => a.slice(-15).localeCompare(b.slice(-15)));
}

export function writeAck(dir: string, by: string): void {
  writeJson(join(dir, "ack.json"), { by, at: now() });
}

export function writeReply(dir: string, reply: Reply): void {
  writeJson(join(dir, "reply.json"), reply);
}

// ---------------------------------------------------------------- board: batch actions + drafts

export type BatchAction = "approve" | "needs_fix" | "accept" | "reject";
export interface BatchResult {
  id: string;
  ok: boolean;
  detail: string;
}

/** One action on many assets; one asset failing does not stop the others. */
export function applyBatch(cfg: LoadedConfig, action: BatchAction, ids: string[]): BatchResult[] {
  if (!["approve", "needs_fix", "accept", "reject"].includes(action)) throw new StoreError("bad batch action");
  if (!Array.isArray(ids) || !ids.length) throw new StoreError("no assets selected");
  return [...new Set(ids)].map((id) => {
    try {
      if (!cfg.byId.has(id)) throw new StoreError("unknown asset");
      const meta = getMeta(cfg, id);
      if (action === "approve" || action === "needs_fix") {
        setStatus(cfg, id, action === "approve" ? "approved" : "needs_fix");
        return { id, ok: true, detail: action === "approve" ? "approved" : "needs fix" };
      }
      if (meta.candidate == null) return { id, ok: false, detail: "no candidate" };
      const n = meta.candidate;
      if (action === "accept") {
        makeCurrent(cfg, id, n);
        return { id, ok: true, detail: `v${n} accepted` };
      }
      rejectCandidate(cfg, id);
      return { id, ok: true, detail: `v${n} rejected` };
    } catch (e) {
      if (!(e instanceof StoreError)) throw e;
      return { id, ok: false, detail: e.message };
    }
  });
}

/**
 * Unsent mark-up per asset (`drafts/<dir>.json`), so a long audit survives a page reload. The page owns the
 * shape; the store only checks it is a JSON object of sane size.
 */
const MAX_DRAFT = 40 * 1024 * 1024;

function draftPath(cfg: LoadedConfig, id: string): string {
  return join(cfg.dataDir, "drafts", `${dirOf(id)}.json`);
}

export function writeDraft(cfg: LoadedConfig, id: string, draft: unknown): void {
  if (!cfg.byId.has(id)) throw new StoreError("unknown asset");
  const p = draftPath(cfg, id);
  if (draft == null) {
    if (existsSync(p)) rmSync(p);
    return;
  }
  if (typeof draft !== "object" || Array.isArray(draft)) throw new StoreError("draft must be an object");
  const text = JSON.stringify(draft);
  if (text.length > MAX_DRAFT) throw new StoreError("draft larger than 40 MB");
  mkdirSync(join(cfg.dataDir, "drafts"), { recursive: true });
  writeFileSync(p, text);
}

export function readDrafts(cfg: LoadedConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of cfg.byId.keys()) {
    try {
      const d = readJson<unknown>(draftPath(cfg, id));
      if (d) out[id] = d;
    } catch {
      /* a corrupt draft is dropped, not fatal */
    }
  }
  return out;
}

// ---------------------------------------------------------------- jobs

/**
 * `job.json` in a Send folder: where the fix for that Send is right now. Written by the queue (queued) and by
 * the fixer at every stage, so a stuck job shows exactly which step it is stuck in, and since when.
 */
export type JobState = "queued" | "running" | "done" | "failed";

export interface Job {
  state: JobState;
  stage: string;
  agent: string;
  /** pid of the studio process that owns the job (the dev server or a `fix` run). */
  owner: number;
  /** pid of the running codex process, if any. */
  pid?: number;
  attempt?: number;
  queuedAt?: string;
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
  candidate?: number;
}

export function readJob(dir: string): Job | null {
  try {
    return readJson<Job>(join(dir, "job.json"));
  } catch {
    return null; // half-written by another process: next poll reads it
  }
}

/** Merge `patch` into the folder's job.json and stamp `updatedAt`. */
export function writeJob(dir: string, patch: Partial<Job>): Job {
  const job = { ...(readJob(dir) ?? { state: "queued", stage: "", agent: "", owner: process.pid }), ...patch, updatedAt: now() } as Job;
  if (patch.state === "queued" || patch.state === "running") delete job.error;
  writeJson(join(dir, "job.json"), job);
  return job;
}

export function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A queued/running job whose owner process is gone will never finish. */
export function isInterrupted(j: Job): boolean {
  return (j.state === "queued" || j.state === "running") && !processAlive(j.owner);
}

/** One line for the page: what the job is doing and for how long. null when there is nothing to show. */
export function jobLabel(j: Job | null, at = Date.now()): string | null {
  if (!j) return null;
  const since = (iso?: string) => (iso ? fmtDuration(at - Date.parse(iso)) : "?");
  if (isInterrupted(j)) return `Interrupted while "${j.stage}" (the studio process stopped). Send again.`;
  if (j.state === "queued") return `Queued for ${since(j.queuedAt)}${j.stage ? ` · ${j.stage}` : ""}`;
  if (j.state === "running") return `${j.agent}: ${j.stage} · ${since(j.startedAt)}`;
  if (j.state === "failed") return `Fix failed: ${(j.error ?? j.stage).replace(/\s+/g, " ").trim()}`;
  return null;
}

/** Every Send folder of the project with its job, newest first. */
export function allJobs(cfg: LoadedConfig): { folder: string; asset: string; job: Job | null; answered: boolean }[] {
  const out: { folder: string; asset: string; job: Job | null; answered: boolean }[] = [];
  for (const id of cfg.byId.keys())
    for (const dir of foldersOf(cfg, id)) out.push({ folder: dir, asset: id, job: readJob(dir), answered: existsSync(join(dir, "reply.json")) });
  return out.sort((a, b) => b.folder.slice(-15).localeCompare(a.folder.slice(-15)));
}

export function readNotes(dir: string): Notes {
  const n = readJson<Notes>(join(dir, "notes.json"));
  if (!n) throw new StoreError(`no notes.json in ${dir}`);
  return n;
}
