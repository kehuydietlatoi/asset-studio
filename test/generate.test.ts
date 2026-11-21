/**
 * Generate from a brief and variant sets, with a fake `codex` on PATH that "generates" by copying the image named
 * in FAKE_GEN_SRC to work/edit-raw.png.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { gridOf, loadConfig } from "../src/config.ts";
import { buildGeneratePrompt, fixFeedback } from "../src/fixer.ts";
import { blank, readPng, writePng, type Img } from "../src/png.ts";
import { applyBatch, getMeta, makeCurrent, readNotes, rejectCandidate, sheetSize, StoreError, variantFiles, writeFeedback, writeGenerateRequest } from "../src/store.ts";

beforeAll(() => {
  const bin = mkdtempSync(join(tmpdir(), "fake-codex-gen-"));
  writeFileSync(
    join(bin, "fake-codex.mjs"),
    `import { copyFileSync } from "node:fs";
process.stdin.resume();
copyFileSync(process.env.FAKE_GEN_SRC, "work/edit-raw.png");
console.log("saved work/edit-raw.png");
process.exit(0);
`,
  );
  writeFileSync(join(bin, "codex.cmd"), `@node "%~dp0fake-codex.mjs" %*\r\n`);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec node "$(dirname "$0")/fake-codex.mjs" "$@"\n`);
  chmodSync(join(bin, "codex"), 0o755);
  process.env.PATH = bin + delimiter + process.env.PATH;
});

const MAGENTA = [255, 0, 255, 255];
const COLOURS = [
  [200, 40, 30, 255],
  [30, 160, 60, 255],
  [40, 60, 200, 255],
  [220, 180, 40, 255],
];

/** A 2×2 sheet of 32 px cells on magenta, a 12 px square of a different colour centred in each cell. */
function sheet(fill: (k: number) => number[] | null, cell = 32, edge = false): Img {
  const im = blank(cell * 2, cell * 2);
  for (let i = 0; i < cell * cell * 4; i++) im.data.set(MAGENTA, i * 4);
  for (let k = 0; k < 4; k++) {
    const c = fill(k);
    if (!c) continue;
    const x0 = (k % 2) * cell + (edge && k === 1 ? 0 : 10), y0 = Math.floor(k / 2) * cell + 10;
    for (let y = y0; y < y0 + 12; y++) for (let x = x0; x < x0 + 12; x++) im.data.set(c, (y * cell * 2 + x) * 4);
  }
  return im;
}

async function project(variants = 4) {
  const dir = mkdtempSync(join(tmpdir(), "as-gen-"));
  writeFileSync(
    join(dir, "asset-studio.config.mjs"),
    `export default { name: "t", agent: "claude", groups: [{ id: "fx", label: "FX", assets: [
      { id: "fx/flame", label: "Flame", file: "fx/burn_flame.png", brief: "a cut-paper flame", variants: ${variants}, size: [32, 32] },
      { id: "fx/nobrief", label: "No brief", file: "fx/none.png" },
    ] }] };`,
  );
  return { dir, cfg: await loadConfig(join(dir, "asset-studio.config.mjs")) };
}

const run = async (cfg: Awaited<ReturnType<typeof project>>["cfg"], src: Img, dir: string, note = "") => {
  writePng(join(dir, "fake-src.png"), src);
  process.env.FAKE_GEN_SRC = join(dir, "fake-src.png");
  const folder = writeGenerateRequest(cfg, "fx/flame", note);
  const r = await fixFeedback(cfg, folder, { agent: "codex" });
  return { folder, r, reply: JSON.parse(readFileSync(join(folder, "reply.json"), "utf8")) };
};

describe("config", () => {
  it("rejects more than 6 variants and bad sizes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-gen-cfg-"));
    const write = (extra: string) => {
      const p = join(dir, `c${Math.random().toString(36).slice(2)}.mjs`);
      writeFileSync(p, `export default { name: "t", agent: "claude", groups: [{ id: "g", label: "G", assets: [{ id: "a", label: "A", file: "a.png", ${extra} }] }] };`);
      return p;
    };
    await expect(loadConfig(write("variants: 7"))).rejects.toThrow(/variants/);
    await expect(loadConfig(write("size: [8, 8]"))).rejects.toThrow(/size/);
    await expect(loadConfig(write("variants: 3, size: [64, 48]"))).resolves.toBeTruthy();
  });

  it("lays variants out on a 2×2 or 3×2 grid", () => {
    expect(gridOf(1)).toEqual([1, 1]);
    expect(gridOf(2)).toEqual([2, 2]);
    expect(gridOf(4)).toEqual([2, 2]);
    expect(gridOf(5)).toEqual([3, 2]);
    expect(sheetSize({ variants: 6 })).toEqual([1536, 1024]);
    expect(sheetSize({})).toEqual([1024, 1024]);
  });
});

describe("generate from a brief", () => {
  it("starts as a brief, refuses edits, and becomes a candidate after Generate", async () => {
    const { dir, cfg } = await project();
    expect(getMeta(cfg, "fx/flame")).toMatchObject({ status: "brief", current: 0, versions: [] });
    const img = "data:image/png;base64," + readFileSync(join(dir, "asset-studio.config.mjs")).toString("base64");
    expect(() => writeFeedback(cfg, { asset: "fx/flame", pins: [], notes: "x", sketch: img, mask: null, photos: [] })).toThrow(/Generate it first/);
    expect(() => writeGenerateRequest(cfg, "fx/nobrief")).toThrow(StoreError);

    const { folder, reply } = await run(cfg, sheet((k) => COLOURS[k]), dir, "more curl");
    expect(readNotes(folder)).toMatchObject({ mode: "generate", imageSize: [64, 64], notes: "more curl" });
    const prompt = readFileSync(join(folder, "work", "image-prompt.txt"), "utf8");
    expect(prompt).toContain("a cut-paper flame");
    expect(prompt).toContain("more curl");
    expect(prompt).toContain("2 columns x 2 rows");
    const meta = getMeta(cfg, "fx/flame");
    expect(meta).toMatchObject({ status: "in_review", current: 0, candidate: 1 });
    expect(meta.versions[0].source).toBe("generate");
    expect(reply.candidate).toBe(1);
    expect(reply.notes).toEqual([]);
  });

  it("Accept writes the sheet and one file per variant (keyed out)", async () => {
    const { dir, cfg } = await project();
    await run(cfg, sheet((k) => COLOURS[k]), dir);
    const [res] = applyBatch(cfg, "accept", ["fx/flame"]);
    expect(res.ok).toBe(true);
    expect(readPng(join(dir, "fx/burn_flame.png")).width).toBe(64);
    const files = variantFiles(cfg.byId.get("fx/flame")!);
    expect(files).toEqual(["fx/burn_flame.1.png", "fx/burn_flame.2.png", "fx/burn_flame.3.png", "fx/burn_flame.4.png"]);
    files.forEach((f, k) => {
      const v = readPng(join(dir, f));
      expect([v.width, v.height]).toEqual([32, 32]);
      expect([...v.data.subarray(0, 4)][3]).toBe(0); // the magenta corner is keyed out
      expect([...v.data.subarray((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4)]).toEqual(COLOURS[k]); // centre = its colour
    });
  });

  it("warns about empty variants and pieces cut at the cell edge", async () => {
    const { dir, cfg } = await project(3);
    const { reply } = await run(cfg, sheet((k) => (k === 2 ? null : COLOURS[k]), 32, true), dir);
    const texts = reply.notes.map((n: { text: string }) => n.text);
    expect(texts).toContain("variant 2 touches its cell edge (may be cut off)");
    expect(texts).toContain("variant 3 is empty");
    expect(reply.summary).toMatch(/check:/);
  });

  it("Reject on a never-accepted asset goes back to brief; a file made outside is imported", async () => {
    const { dir, cfg } = await project();
    await run(cfg, sheet((k) => COLOURS[k]), dir);
    expect(rejectCandidate(cfg, "fx/flame").status).toBe("brief");
    expect(getMeta(cfg, "fx/flame").current).toBe(0);
    const m2 = makeCurrent(cfg, "fx/flame", 1); // an older generated version can still be used
    expect(m2.current).toBe(1);
    expect(existsSync(join(dir, "fx/burn_flame.3.png"))).toBe(true);

    const fresh = await project(1);
    writePng(join(fresh.dir, "fx_outside.png"), blank(4, 4));
    // simulate: the brief asset's file appears later
    getMeta(fresh.cfg, "fx/flame");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(fresh.dir, "fx"), { recursive: true });
    writePng(join(fresh.dir, "fx/burn_flame.png"), blank(4, 4));
    expect(getMeta(fresh.cfg, "fx/flame")).toMatchObject({ status: "generated", current: 1 });
  });

  it("a single image has no grid and is told to keep a margin", () => {
    const p = buildGeneratePrompt({ brief: "a stun star", variants: 1 }, "", "#FF00FF", 1);
    expect(p).toContain("1024x1024");
    expect(p).not.toContain("columns");
    expect(p).toContain("REFERENCES only");
    const three = buildGeneratePrompt({ brief: "ember", variants: 3, size: [256, 256] }, "", "#FF00FF", 0);
    expect(three).toContain("512x512");
    expect(three).toContain("leave the last 1 cell(s) completely empty");
  });
});
