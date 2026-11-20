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
  /** Free text the fixer adds to every edit prompt for this asset (what it is, what must stay). */
  brief?: string;
}

export interface GroupDef {
  id: string;
  label: string;
  assets: AssetDef[];
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
  port?: number;
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
      byId.set(a.id, { ...a, group: g.id });
    }
  }
  if (cfg.agent !== "claude" && cfg.agent !== "codex") throw new Error(`agent must be "claude" or "codex"`);
  return { ...cfg, root, dataDir: resolve(root, ".asset-studio"), byId, abs };
}
