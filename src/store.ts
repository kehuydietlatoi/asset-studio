/**
 * Studio data on disk, inside the game repo at `.asset-studio/`:
 *   assets/<dir>/meta.json, v<n>.png   version history + review status of one asset
 *   feedback/<dir>/<stamp>/            one Send: notes.json, sketch.png, mask.png?, photos/, before.png,
 *                                      status.json (written last = complete), ack.json, reply.json
 * <dir> is the asset id with "/" replaced by "__".
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedConfig } from "./config.ts";
import { readPng } from "./png.ts";

export type ReviewStatus = "generated" | "in_review" | "needs_fix" | "approved";

export interface VersionInfo {
  n: number;
  at: string;
  source: "import" | "fix" | "manual";
  parent?: number;
  prompt?: string;
  feedback?: string;
  agent?: string;
}

export interface Meta {
  id: string;
  status: ReviewStatus;
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

/** Meta of an asset; the first call imports the configured file as v1. */
export function getMeta(cfg: LoadedConfig, id: string): Meta {
  const a = cfg.byId.get(id);
  if (!a) throw new StoreError(`unknown asset ${id}`);
  const dir = assetDir(cfg, id);
  const metaPath = join(dir, "meta.json");
  const meta = readJson<Meta>(metaPath);
  if (meta) return meta;
  const src = cfg.abs(a.file);
  if (!existsSync(src)) throw new StoreError(`asset file missing: ${a.file}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, join(dir, "v1.png"));
  const fresh: Meta = { id, status: "generated", current: 1, candidate: null, versions: [{ n: 1, at: now(), source: "import" }] };
  writeJson(metaPath, fresh);
  return fresh;
}

function saveMeta(cfg: LoadedConfig, meta: Meta): void {
  writeJson(join(assetDir(cfg, meta.id), "meta.json"), meta);
}

/** Store a new version as the candidate (shown as "after" until accepted or rejected). Returns its number. */
export function addCandidate(cfg: LoadedConfig, id: string, pngPath: string, info: Omit<VersionInfo, "n" | "at">): number {
  const meta = getMeta(cfg, id);
  const n = Math.max(...meta.versions.map((v) => v.n)) + 1;
  copyFileSync(pngPath, versionPath(cfg, id, n));
  meta.versions.push({ n, at: now(), ...info });
  meta.candidate = n;
  meta.status = "in_review";
  saveMeta(cfg, meta);
  return n;
}

/** Make version n current and write it to the game's asset file. */
export function makeCurrent(cfg: LoadedConfig, id: string, n: number): Meta {
  const meta = getMeta(cfg, id);
  if (!meta.versions.some((v) => v.n === n)) throw new StoreError(`no version ${n}`);
  copyFileSync(versionPath(cfg, id, n), cfg.abs(cfg.byId.get(id)!.file));
  meta.current = n;
  if (meta.candidate === n) meta.candidate = null;
  saveMeta(cfg, meta);
  return meta;
}

export function rejectCandidate(cfg: LoadedConfig, id: string): Meta {
  const meta = getMeta(cfg, id);
  meta.candidate = null;
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

export function readNotes(dir: string): Notes {
  const n = readJson<Notes>(join(dir, "notes.json"));
  if (!n) throw new StoreError(`no notes.json in ${dir}`);
  return n;
}
