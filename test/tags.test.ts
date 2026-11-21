import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { blank, writePng } from "../src/png.ts";
import { StoreError } from "../src/store.ts";
import { allTags, createTag, deleteTag, editTagAssets, matchPattern, renameTag, tagsOf } from "../src/tags.ts";

async function project(tags = "") {
  const dir = mkdtempSync(join(tmpdir(), "as-tags-"));
  writePng(join(dir, "a.png"), blank(2, 2));
  const unit = (n: string, s: number) => `{ id: "unit/ad_u_${n}/s${s}", label: "U${n} ${s}", file: "a.png" }`;
  writeFileSync(
    join(dir, "asset-studio.config.mjs"),
    `export default { name: "t", agent: "claude", ${tags}
      groups: [
        { id: "s1", label: "Units 1★", assets: [${unit("01", 1)}, ${unit("02", 1)}] },
        { id: "s2", label: "Units 2★", assets: [${unit("01", 2)}, ${unit("02", 2)}] },
        { id: "icons", label: "Icons", assets: [{ id: "icon/ad_s_01", label: "I", file: "a.png" }] },
      ] };`,
  );
  return loadConfig(join(dir, "asset-studio.config.mjs"));
}

describe("tag patterns", () => {
  it("* stays inside a segment, ** crosses them", () => {
    expect(matchPattern("unit/*/s2", "unit/ad_u_01/s2")).toBe(true);
    expect(matchPattern("unit/*/s2", "unit/ad_u_01/s1")).toBe(false);
    expect(matchPattern("unit/*", "unit/ad_u_01/s2")).toBe(false);
    expect(matchPattern("unit/**", "unit/ad_u_01/s2")).toBe(true);
    expect(matchPattern("icon/ad_*", "icon/ad_s_01")).toBe(true);
    expect(matchPattern("a.b", "aXb")).toBe(false); // dots are literal
  });
});

describe("tags", () => {
  it("groups and config tags overlap: one asset in several tags", async () => {
    const cfg = await project(`tags: [
      { id: "tank", label: "Tank", match: "unit/ad_u_01/*" },
      { id: "faction-ad", label: "Âu Lạc", match: ["unit/**", "icon/ad_*"] },
    ],`);
    const t = Object.fromEntries(allTags(cfg).map((x) => [x.id, x]));
    expect(t.s1.kind).toBe("group");
    expect(t.tank.assets).toEqual(["unit/ad_u_01/s1", "unit/ad_u_01/s2"]);
    expect(t["faction-ad"].assets).toHaveLength(5);
    expect(tagsOf(cfg, "unit/ad_u_01/s1").map((x) => x.label)).toEqual(["Units 1★", "Tank", "Âu Lạc"]);
  });

  it("rejects config tags that clash with groups or use the user prefix", async () => {
    await expect(project(`tags: [{ id: "s1", label: "X", match: "x" }],`)).rejects.toThrow(/already used/);
    await expect(project(`tags: [{ id: "my-x", label: "X", match: "x" }],`)).rejects.toThrow(/reserved/);
  });

  it("user tags: create, fill, rename, delete; persisted; config tags stay read-only", async () => {
    const cfg = await project(`tags: [{ id: "tank", label: "Tank", match: "unit/ad_u_01/*" }],`);
    const t = createTag(cfg, "  Map  objects ", ["icon/ad_s_01"]);
    expect(t).toMatchObject({ id: "my-map-objects", label: "Map objects", kind: "user" });
    expect(createTag(cfg, "Đồ vật").id).toBe("my-do-vat");
    expect(() => createTag(cfg, "tank")).toThrow(/already exists/);
    expect(() => createTag(cfg, "x", ["nope"])).toThrow(StoreError);

    expect(editTagAssets(cfg, t.id, ["unit/ad_u_02/s1", "icon/ad_s_01"], [])).toBe(2);
    expect(editTagAssets(cfg, t.id, [], ["icon/ad_s_01"])).toBe(1);
    renameTag(cfg, t.id, "Props");

    const again = await loadConfig(join(cfg.root, "asset-studio.config.mjs")); // fresh load reads tags.json
    expect(allTags(again).find((x) => x.id === t.id)).toMatchObject({ label: "Props", assets: ["unit/ad_u_02/s1"] });

    expect(() => editTagAssets(cfg, "tank", ["icon/ad_s_01"])).toThrow(/config file/);
    expect(() => renameTag(cfg, "s1", "x")).toThrow(/config file/);
    deleteTag(cfg, t.id);
    expect(allTags(cfg).some((x) => x.id === t.id)).toBe(false);
  });
});
