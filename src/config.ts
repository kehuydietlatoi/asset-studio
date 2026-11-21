/**
 * Per-game configuration. Each game repo has an `asset-studio.config.mjs` that default-exports a StudioConfig.
 * All paths in it are relative to the config file's folder (the game root).
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type AgentMode = "claude" | "codex";

export interface AssetDef {
  /** Stable id, letters, digits, `_ - . /` only. Example: `unit/ad_u_01/s1`. */
  id: string;
  label: string;
  /** The current RGBA PNG (transparent background). Accepting a new version overwrites this file. */
  file: string;
  /** Drawn height relative to other assets in the line-up (1 = normal soldier). */
  scale?: number;
  /** Free text the fixer adds to every edit prompt for this asset (what it is, what must stay). Also what Generate draws. */
  brief?: string;
  /**
   * Generate draws this many variants of the same subject in one image (a grid: 2-4 → 2×2, 5-6 → 3×2; unused cells
   * stay empty), so they match each other. Accept writes the whole sheet to `file` and each variant to
   * `<file stem>.<k>.png`. Default 1 (a single image).
   */
  variants?: number;
  /** Canvas of one image (one cell of a variant sheet) for Generate, [width, height]. Default 1024×1024, or 512×512 per cell. */
  size?: [number, number];
  /** Text file that replaces the project's `styleBlock` for this asset (e.g. effects need different rules than figures). */
  styleBlock?: string;
  /** Extra reference images attached when generating or editing this asset (e.g. the unit an effect sits on). */
  refs?: string[];
  /** How the Overlay view previews this asset on top of other sprites (effects, status icons). */
  overlay?: OverlayDef;
}

/** Overlay view settings for one asset: drawn on top of base sprites, at game size, as ally and with the enemy tint. */
export interface OverlayDef {
  /** Asset ids of the base sprites to draw it on. Default: `overlay.bases` from the config. */
  on?: string[];
  /** Where the centre of the piece sits on the base sprite's box, 0..1 (x from left, y from top). Default [0.5, 0.45]. */
  anchor?: [number, number];
  /** Height of the piece relative to the base sprite's height. Default 0.45. */
  size?: number;
  /** `flicker` swaps variants with a jitter (flames), `orbit` circles them over the head (stun stars), `rise` floats them up and fades (embers), `none` stands still. Default flicker. */
  motion?: "flicker" | "orbit" | "rise" | "none";
  /** How many copies are drawn at once (orbit/rise). Default 3 for orbit/rise, else 1. */
  count?: number;
  /** A status icon: drawn small next to a health bar over the head instead of on the body. */
  icon?: boolean;
}

/** Project-wide Overlay view settings. */
export interface OverlayConfig {
  /** Base sprites the overlays are previewed on (asset ids), e.g. a tank, an archer and the hero. */
  bases?: string[];
  /** Height of a base sprite's box in the preview, in px, like in the game. Default 120. */
  baseHeight?: number;
  /** Looks to show each base in, e.g. ally and enemy: `color` is mixed over the sprite with `alpha`. Default: plain only. */
  tints?: { label: string; color?: string; alpha?: number }[];
}

/** Grid of a variant sheet: [columns, rows]. */
export function gridOf(variants = 1): [number, number] {
  if (variants <= 1) return [1, 1];
  if (variants <= 4) return [2, 2];
  return [3, 2];
}

/** Size of one cell (or the single image) that Generate draws. */
export function cellSize(a: Pick<AssetDef, "variants" | "size">): [number, number] {
  return a.size ?? ((a.variants ?? 1) > 1 ? [512, 512] : [1024, 1024]);
}

export interface GroupDef {
  id: string;
  label: string;
  assets: AssetDef[];
}

/**
 * A tag defined in the config. Members are picked by id patterns (`*` = within one id segment, `**` = anything,
 * so `unit/*\/s2` is every 2★ unit) and/or an explicit list. Assets added to the config later join by themselves.
 * Every config group is also a tag; users can add their own tags in the page (`.asset-studio/tags.json`).
 */
export interface TagDef {
  id: string;
  label: string;
  match?: string | string[];
  assets?: string[];
}

export interface StudioConfig {
  name: string;
  /** Who answers a Send: `claude` (Claude Code via the skill + watcher) or `codex` (the server runs the fixer itself). */
  agent: AgentMode;
  /** Style reference images attached to every image edit. */
  styleRefs?: string[];
  /** Text file whose content starts every edit prompt (lines starting with `#` are dropped). */
  styleBlock?: string;
  /** Background colour the fixer puts behind the image for the model, keyed out afterwards. */
  keyColor?: [number, number, number];
  /** Line-up stage look. */
  stage?: { sky?: string; ground?: string; groundY?: number };
  groups: GroupDef[];
  /** Extra tags across groups (by role, faction, tier...). */
  tags?: TagDef[];
  /** Overlay view: base sprites, their size and tints. */
  overlay?: OverlayConfig;
  port?: number;
  /** Kill a Codex image edit that runs longer than this (minutes) and fail the job, so the queue moves on. Default 10. */
  fixTimeoutMin?: number;
}

export interface LoadedConfig extends StudioConfig {
  /** Absolute game root (the config file's folder). */
  root: string;
  /** Absolute studio data folder: `<root>/.asset-studio`. */
  dataDir: string;
  byId: Map<string, AssetDef & { group: string }>;
  abs(p: string): string;
}

const ID_RE = /^[A-Za-z0-9_.\-/]{1,120}$/;
export const TAG_ID_RE = /^[A-Za-z0-9_.-]{1,60}$/;

export function validateId(id: string): boolean {
  return ID_RE.test(id) && !id.includes("..") && !id.startsWith("/");
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const file = resolve(path);
  if (!existsSync(file)) throw new Error(`config not found: ${file}`);
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  const cfg = (mod.default ?? mod) as StudioConfig;
  const root = dirname(file);
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
  const byId = new Map<string, AssetDef & { group: string }>();
  for (const g of cfg.groups) {
    for (const a of g.assets) {
      if (!validateId(a.id)) throw new Error(`bad asset id: ${a.id}`);
      if (byId.has(a.id)) throw new Error(`duplicate asset id: ${a.id}`);
      const v = a.variants ?? 1;
      if (!Number.isInteger(v) || v < 1 || v > 6) throw new Error(`${a.id}: variants must be 1 to 6`);
      if (a.size && !(a.size.length === 2 && a.size.every((n) => Number.isInteger(n) && n >= 16 && n <= 2048)))
        throw new Error(`${a.id}: size must be [width, height], 16 to 2048 px`);
      byId.set(a.id, { ...a, group: g.id });
    }
  }
  if (cfg.agent !== "claude" && cfg.agent !== "codex") throw new Error(`agent must be "claude" or "codex"`);
  const tagIds = new Set(cfg.groups.map((g) => g.id));
  for (const t of cfg.tags ?? []) {
    if (!TAG_ID_RE.test(t.id)) throw new Error(`bad tag id: ${t.id} (letters, digits, _ - . only)`);
    if (tagIds.has(t.id)) throw new Error(`tag id ${t.id} is already used by a group or another tag`);
    if (t.id.startsWith("my-")) throw new Error(`tag id ${t.id}: the "my-" prefix is reserved for tags made in the page`);
    if (!t.label?.trim()) throw new Error(`tag ${t.id} needs a label`);
    tagIds.add(t.id);
  }
  return { ...cfg, root, dataDir: resolve(root, ".asset-studio"), byId, abs };
}
