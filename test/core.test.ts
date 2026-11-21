import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { blank, composite, flatten, keyOut, maskFrom, readPng, resize, softenMask, writePng } from "../src/png.ts";
import { addCandidate, applyBatch, getMeta, makeCurrent, pendingFeedback, readDrafts, StoreError, writeDraft, writeFeedback } from "../src/store.ts";
import { buildInstruction, fixFeedback } from "../src/fixer.ts";

const solid = (w: number, h: number, rgba: number[]) => {
  const im = blank(w, h);
  for (let i = 0; i < w * h; i++) im.data.set(rgba, i * 4);
  return im;
};
const dataUrl = (path: string) => "data:image/png;base64," + readFileSync(path).toString("base64");

async function project() {
  const dir = mkdtempSync(join(tmpdir(), "as-"));
  writePng(join(dir, "a.png"), solid(8, 8, [200, 50, 30, 255]));
  writeFileSync(
    join(dir, "asset-studio.config.mjs"),
    `export default { name: "t", agent: "claude", groups: [{ id: "g", label: "G", assets: [{ id: "unit/a", label: "A", file: "a.png", brief: "a red block" }] }] };`,
  );
  return { dir, cfg: await loadConfig(join(dir, "asset-studio.config.mjs")) };
}

describe("png helpers", () => {
  it("keys out the background and unmixes the fringe", () => {
    const im = solid(2, 1, [255, 0, 255, 255]);
    im.data.set([180, 40, 160, 255], 4); // pink-tinted edge pixel
    const k = keyOut(im, [255, 0, 255], 60);
    expect(k.data[3]).toBe(0);
    expect(k.data[7]).toBeGreaterThan(0);
  });

  it("composites only inside the mask", () => {
    const base = solid(4, 1, [0, 0, 0, 255]);
    const top = solid(4, 1, [255, 255, 255, 255]);
    const out = composite(base, top, new Float32Array([0, 0, 1, 1]));
    expect([...out.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...out.data.subarray(8, 12)]).toEqual([255, 255, 255, 255]);
  });

  it("grows and feathers a mask", () => {
    const m = new Float32Array(21 * 21);
    m[10 * 21 + 10] = 1;
    const s = softenMask(m, 21, 21, 3, 2);
    expect(s[10 * 21 + 10]).toBeGreaterThan(0.8); // grown 7x7 block, feathered
    expect(s[10 * 21 + 13]).toBeGreaterThan(0.1); // grown 3 px out
    expect(s[0]).toBe(0);
  });

  it("flattens and resizes", () => {
    const f = flatten(solid(2, 2, [0, 0, 0, 0]), [255, 0, 255]);
    expect([...f.data.subarray(0, 4)]).toEqual([255, 0, 255, 255]);
    expect(resize(f, 5, 3).width).toBe(5);
    expect(maskFrom(solid(2, 2, [255, 255, 255, 255]), 4, 4)[5]).toBeCloseTo(1);
  });
});

describe("store", () => {
  it("imports v1, adds a candidate and accepts it into the game file", async () => {
    const { dir, cfg } = await project();
    expect(getMeta(cfg, "unit/a").current).toBe(1);
    writePng(join(dir, "new.png"), solid(8, 8, [0, 0, 255, 255]));
    const n = addCandidate(cfg, "unit/a", join(dir, "new.png"), { source: "fix", parent: 1 });
    expect(n).toBe(2);
    expect(getMeta(cfg, "unit/a").candidate).toBe(2);
    makeCurrent(cfg, "unit/a", 2);
    expect(readPng(join(dir, "a.png")).data[2]).toBe(255);
    expect(getMeta(cfg, "unit/a").candidate).toBeNull();
  });

  it("writes a Send folder and lists it as pending; refuses unknown assets", async () => {
    const { dir, cfg } = await project();
    const img = dataUrl(join(dir, "a.png"));
    const folder = writeFeedback(cfg, { asset: "unit/a", pins: [{ n: 1, x: 2, y: 3, text: "make it blue" }], notes: "", sketch: img, mask: img, photos: [] });
    expect(existsSync(join(folder, "status.json"))).toBe(true);
    expect(existsSync(join(folder, "before.png"))).toBe(true);
    expect(pendingFeedback(cfg)).toEqual([folder]);
    expect(() => writeFeedback(cfg, { asset: "../x", pins: [], notes: "x", sketch: img, mask: null, photos: [] })).toThrow(StoreError);
  });

  it("builds the edit prompt from pins (dry run)", async () => {
    const { dir, cfg } = await project();
    const img = dataUrl(join(dir, "a.png"));
    const folder = writeFeedback(cfg, { asset: "unit/a", pins: [{ n: 1, x: 2, y: 3, text: "make it blue" }], notes: "keep size", sketch: img, mask: img, photos: [] });
    const r = await fixFeedback(cfg, folder, { agent: "claude", dryRun: true });
    expect(r.prompt).toContain("THE ONLY CHANGE:");
    expect(r.prompt).toContain("1. make it blue");
    expect(buildInstruction({ asset: "unit/a", version: 1, imageSize: [8, 8], pins: [], notes: "x", hasMask: false }, "b")).toContain("Asset: b");
  });
});

describe("board batch + drafts", () => {
  it("applies one action to many assets, skipping what does not apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-b-"));
    for (const n of ["a", "b"]) writePng(join(dir, `${n}.png`), solid(4, 4, [9, 9, 9, 255]));
    writeFileSync(
      join(dir, "asset-studio.config.mjs"),
      `export default { name: "t", agent: "claude", groups: [{ id: "g", label: "G", assets: [{ id: "u/a", label: "A", file: "a.png" }, { id: "u/b", label: "B", file: "b.png" }] }] };`,
    );
    const cfg = await loadConfig(join(dir, "asset-studio.config.mjs"));
    writePng(join(dir, "new.png"), solid(4, 4, [0, 200, 0, 255]));
    addCandidate(cfg, "u/a", join(dir, "new.png"), { source: "fix", parent: 1 });

    const acc = applyBatch(cfg, "accept", ["u/a", "u/b", "u/a"]);
    expect(acc).toEqual([
      { id: "u/a", ok: true, detail: "v2 accepted" },
      { id: "u/b", ok: false, detail: "no candidate" },
    ]);
    expect(readPng(join(dir, "a.png")).data[1]).toBe(200);
    expect(applyBatch(cfg, "approve", ["u/a", "u/b", "nope"]).map((r) => r.ok)).toEqual([true, true, false]);
    expect(getMeta(cfg, "u/b").status).toBe("approved");
    expect(() => applyBatch(cfg, "delete" as never, ["u/a"])).toThrow(StoreError);

    writeDraft(cfg, "u/b", { items: [{ kind: "pin", x: 1, y: 1, text: "fix" }], notes: "", photos: [] });
    expect(readDrafts(cfg)).toEqual({ "u/b": { items: [{ kind: "pin", x: 1, y: 1, text: "fix" }], notes: "", photos: [] } });
    writeDraft(cfg, "u/b", null);
    expect(readDrafts(cfg)).toEqual({});
    expect(() => writeDraft(cfg, "../x", {})).toThrow(StoreError);
  });
});
