/**
 * Tags: overlapping sets of assets ("Âu Lạc", "Tank", "1★"). Three kinds, one id space:
 *   group   every config group (read-only in the page)
 *   config  `tags` in the config, members by id pattern or list (read-only in the page)
 *   user    made in the page, stored in `.asset-studio/tags.json` (ids start with "my-")
 * A tag only lists asset ids; images are never copied.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedConfig } from "./config.ts";
import { StoreError } from "./store.ts";

export type TagKind = "group" | "config" | "user";

export interface Tag {
  id: string;
  label: string;
  kind: TagKind;
  /** Member asset ids, in config order. */
  assets: string[];
}

interface UserTag {
  id: string;
  label: string;
  assets: string[];
}

const MAX_LABEL = 60;

/** `*` matches inside one id segment, `**` matches anything (including `/`). */
export function matchPattern(pattern: string, id: string): boolean {
  const re = pattern
    .split("**")
    .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${re}$`).test(id);
}

function tagsFile(cfg: LoadedConfig): string {
  return join(cfg.dataDir, "tags.json");
}

function readUserTags(cfg: LoadedConfig): UserTag[] {
  const p = tagsFile(cfg);
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as { tags?: UserTag[] };
    return Array.isArray(data.tags) ? data.tags : [];
  } catch {
    throw new StoreError(`${p} is not valid JSON; fix or delete it`);
  }
}

function writeUserTags(cfg: LoadedConfig, tags: UserTag[]): void {
  mkdirSync(cfg.dataDir, { recursive: true });
  writeFileSync(tagsFile(cfg), JSON.stringify({ tags }, null, 2));
}

/** Every tag with its members resolved against the current config (unknown ids are dropped). */
export function allTags(cfg: LoadedConfig): Tag[] {
  const order = [...cfg.byId.keys()];
  const known = (ids: Iterable<string>) => {
    const set = new Set(ids);
    return order.filter((id) => set.has(id));
  };
  const out: Tag[] = cfg.groups.map((g) => ({ id: g.id, label: g.label, kind: "group", assets: g.assets.map((a) => a.id) }));
  for (const t of cfg.tags ?? []) {
    const patterns = t.match == null ? [] : Array.isArray(t.match) ? t.match : [t.match];
    const hits = order.filter((id) => patterns.some((p) => matchPattern(p, id)));
    out.push({ id: t.id, label: t.label, kind: "config", assets: known([...hits, ...(t.assets ?? [])]) });
  }
  for (const t of readUserTags(cfg)) out.push({ id: t.id, label: t.label, kind: "user", assets: known(t.assets) });
  return out;
}

/** Tags an asset belongs to. */
export function tagsOf(cfg: LoadedConfig, assetId: string): Tag[] {
  return allTags(cfg).filter((t) => t.assets.includes(assetId));
}

function cleanLabel(cfg: LoadedConfig, label: unknown, exceptId?: string): string {
  const l = String(label ?? "").trim().replace(/\s+/g, " ");
  if (!l) throw new StoreError("tag name is empty");
  if (l.length > MAX_LABEL) throw new StoreError(`tag name longer than ${MAX_LABEL} characters`);
  const clash = allTags(cfg).find((t) => t.id !== exceptId && t.label.toLowerCase() === l.toLowerCase());
  if (clash) throw new StoreError(`a tag named "${clash.label}" already exists`);
  return l;
}

function checkAssets(cfg: LoadedConfig, ids: unknown): string[] {
  if (!Array.isArray(ids)) throw new StoreError("assets must be a list");
  for (const id of ids) if (!cfg.byId.has(id)) throw new StoreError(`unknown asset ${String(id).slice(0, 80)}`);
  return [...new Set(ids as string[])];
}

function editable(cfg: LoadedConfig, id: string): { tags: UserTag[]; tag: UserTag } {
  const tags = readUserTags(cfg);
  const tag = tags.find((t) => t.id === id);
  if (tag) return { tags, tag };
  if (allTags(cfg).some((t) => t.id === id)) throw new StoreError("this tag comes from the config file; edit it there");
  throw new StoreError("unknown tag");
}

export function createTag(cfg: LoadedConfig, label: unknown, assets: unknown = []): Tag {
  const l = cleanLabel(cfg, label);
  const members = checkAssets(cfg, assets);
  const tags = readUserTags(cfg);
  const base =
    "my-" +
    (l
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "tag");
  const taken = new Set(allTags(cfg).map((t) => t.id));
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  tags.push({ id, label: l, assets: members });
  writeUserTags(cfg, tags);
  return { id, label: l, kind: "user", assets: members };
}

export function renameTag(cfg: LoadedConfig, id: string, label: unknown): void {
  const { tags, tag } = editable(cfg, id);
  tag.label = cleanLabel(cfg, label, id);
  writeUserTags(cfg, tags);
}

export function deleteTag(cfg: LoadedConfig, id: string): void {
  const { tags } = editable(cfg, id);
  writeUserTags(
    cfg,
    tags.filter((t) => t.id !== id),
  );
}

/** Add and/or remove members of a user tag. Returns the new member count. */
export function editTagAssets(cfg: LoadedConfig, id: string, add: unknown = [], remove: unknown = []): number {
  const { tags, tag } = editable(cfg, id);
  const plus = checkAssets(cfg, add);
  const minus = new Set(checkAssets(cfg, remove));
  tag.assets = [...new Set([...tag.assets, ...plus])].filter((a) => !minus.has(a));
  writeUserTags(cfg, tags);
  return tag.assets.length;
}
