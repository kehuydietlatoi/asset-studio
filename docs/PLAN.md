# Asset Studio — plan (draft for owner review, 2026-11-20)

A reusable local tool for every game: open any game asset **in context**, mark up what is wrong, press
Send, and an agent (Claude Code) fixes it while you watch, with a reply per mark-up pin and a before/after
view. Extracted from gameanmay's Art Studio (decision 0057, `tools/studio/`, `.claude/skills/art-studio`),
generalised so it also works for **AI-generated raster art** (first user: Heroes of Vietnam).

## 1. What carries over from gameanmay unchanged

- Local Vite page on `127.0.0.1`, never part of a game build.
- Mark-up tools: pen, arrow, numbered text pins, eraser, undo/redo, 4 colours, pasted reference photos.
- The **feedback folder protocol**: `feedback/<assetId>/<timestamp>/` with `sketch.png`, `notes.json`,
  `photos/`, `before.*`, `status.json`; the agent writes `ack.json` then `reply.json`
  (`fixed` / `question` / `wont` per pin); the page polls replies every 2 s.
- The watcher script + Claude skill loop (ack first, read, fix, look at the result, reply).
- Before/after toggle and slider.

## 2. What is new

| Need | Why | Design |
| --- | --- | --- |
| **Per-game adapter** | gameanmay hard-codes its registry, stage and recipe paths | `asset-studio.config.ts` in each game repo: asset list, how to render each asset, stage (context scene), fixer type, build/cleanup commands |
| **Raster fixer** | AI images can't be fixed by editing code; full re-generation drifts | Pins and pen strokes become a **mask**. Edit = current image + mask + "THE ONLY CHANGE: <pin text>". Result is **composited back only inside the mask** (feathered), so nothing outside the marked area can change. Then the game's cleanup command runs |
| **Fixer back-ends** | Different games, different tools | `code` (agent edits SVG/canvas recipes, as gameanmay); `codex-image` (Codex CLI `image_gen`, mask sent as a second image); `openai-edit` (true inpainting with a mask, when an API key exists) |
| **Version history** | Raster edits are not diffable | Every accepted change saves `v<n>.png` + prompt + parent version; one click to roll back or compare any two versions |
| **Review board** | Batch audits like the HOV 1★ audit | Grid of all assets in a group with status chips (`brief` → `generated` → `in review` → `approved`), filters, multi-select "send all marked" |
| **Style lock** | Keep every asset in the approved style | Per-project style references and style block; the raster fixer always attaches them |
| **Stage adapters** | Judge assets in the game, not on a blank canvas | Built-ins: `strip` (gameanmay street), `lineup` (side-view battle line, per-unit scale values), `sheet` (animation frames), `plain` |

## 3. Shape

```
asset-studio/                 (new repo, this folder)
  packages/core/              page shell, mark-up, feedback protocol, versions, review board
  packages/fixers/            code | codex-image | openai-edit, mask + composite
  packages/stages/            strip | lineup | sheet | plain
  skill/asset-studio/SKILL.md the Claude loop, game-agnostic; reads the game's config
  cli/                        `asset-studio dev` (serve) · `asset-studio watch` (agent watcher)
games use it as: npx asset-studio dev --config ./asset-studio.config.ts
```

## 4. Milestones

| # | Deliverable | Done when |
| --- | --- | --- |
| M1 | Extract gameanmay studio into `core` + `code` fixer + `strip` stage; gameanmay switches to it | gameanmay's studio works exactly as before from the new package |
| M2 | `codex-image` fixer with mask + composite, version history, `lineup` stage | The HOV audit items (11, 12, 13, 09 …) are fixed through the studio, no manual prompts |
| M3 | Review board + status chips; HOV 2★/3★ forms reviewed in it | A whole unit group can be audited and sent in one pass |
| M4 | `openai-edit` fixer, `sheet` stage for animation frames | Animation frames can be marked up frame by frame |
| M5 | Tags + saved rules + mass regenerate (section 6) | A rule saved on a tag is applied to up to 10 selected images with a pilot, auto-masks and a review grid |

## 5. Owner decisions (2026-11-20)

- New standalone repo, no dependency on gameanmay; reuse the ideas, rebuild code as needed.
- Both agents: Claude (skill + watcher) and Codex (server runs the fixer itself).
- Start with what helps Heroes of Vietnam most: M2 first (raster fixer, versions, line-up). M1 (moving gameanmay
  over) is now optional.
- Local only.

Status: M2 core built and tested end to end on HOV unit AD_U_11 (masked crest swap).

M3 (2026-11-21): board filters with counts, multi-select (Shift range), batch Approve / Needs fix / Accept / Reject,
"Send all marked", "Send note to selected", server-side drafts. Also a fix timeout and studio log
(`fixTimeoutMin`, `.asset-studio/logs/studio.log`). Still open in M3: the real HOV 2★/3★ audit run through the board.

Generate + variant sets + overlay (2026-11-22, for HOV status effects): assets with a brief but no file
(status `brief`), Generate one or up to 10 from the Board, variant sheets (2×2 / 3×2) split into per-variant files on
Accept with empty / cut-off checks, Redo one variant (masked cell edit), per-asset `styleBlock` / `refs`, and an
Overlay view (effects on real sprites at game size, ally + enemy tint, flicker / orbit / rise / icon). This covers
what M4's `sheet` stage was for when the game animates pieces itself; frame-by-frame mark-up stays open.

## 6. M5: tags and saved rules (user feedback, 2026-11-21)

### The request (HOV user, translated)

1. Group images into folders for easier management: map objects, backgrounds, by hero, by unit type, etc.
2. Mass edit by a new rule: change the texture everywhere, add one detail to every image, or change the colour rule
   for every image. Ideally: select the images, apply the new rule, regenerate them all.

### Why M3 does not cover it

- M3 **groups** come from `asset-studio.config.mjs` (only the dev edits them) and each asset is in exactly one group.
  The request needs user-managed, overlapping sets: unit 01 is "Âu Lạc" and "Tank" and "1★" at once.
- M3 **"Send note to selected"** is a one-off instruction, not saved, with no consistency across images and no
  "which images are behind the current rules" view.

### Owner decisions (grilling session, 2026-11-21)

| Topic | Decision |
| --- | --- |
| Folder model | **Tags**: one image in any number of tags. Stored as id lists; images are never copied (no storage cost; the storage cost is versions, ~1 MB per regenerated image) |
| Who edits tags | **Both**: config defines starting tags (existing groups become tags, plus `tags` with id patterns); users create, rename and fill tags in the page |
| Rule lifetime | **Saved rules**, kept with a revision history |
| Rule scope | A rule belongs to **one tag** and applies to every image in it, including images added later |
| What a rule may change | **Auto-mask by words**: the rule names a region ("the shield", "the helmet") and the agent finds it in each image; or the region is **"whole image"** (texture, palette), with a drift warning |
| Existing art when a rule is added or edited | **Marked outdated** (chip + Board filter); nothing regenerates by itself. Editing a rule's text makes its images outdated again |
| Consistency | **Pilot first**: the user picks **1-3 pilots** in the batch; they run alone; once accepted, their results are style references for the rest |
| Auto-mask checking | **Only flagged masks stop for review**; the rest run straight through |
| Rule clashes (image in two tags with contradicting rules) | **All rules go into the prompt; the agent merges them** |
| Cost limit | **Hard cap: 10 images per batch** |
| Review | **Review grid**: before/after on each card, tick, Accept selected / Reject selected |

Two safeguards added on top of those choices:

- "Flagged" masks are decided by **checks, not by the model's self-reported confidence** (not reliable): mask
  empty, mask over 60% of the image, or area more than 3x off the batch median. Flagged images pause; the user fixes
  the mask in Focus (pre-filled) and resumes.
- Because clashes are merged silently, **every version records which rules (id + revision) went into it**, so an
  unexpected result can be traced to its rules.

### Data (all in `.asset-studio/`, game files untouched until Accept)

- `tags.json`: user tags `{ id, label, assets: [ids] }`. Config tags are read-only in the page: every config
  `group` is a tag, and the config may add `tags: [{ id, label, match: "unit/*/s2" }]` (patterns, so new assets join
  by themselves).
- `rules.json`: `{ id, tag, text, region: "whole" | "<words>", rev, history: [{ rev, text, region, at }] }`.
- Version entries in `meta.json` gain `rules: [{ id, rev }]` and `refs` (pilot versions used).
- **Outdated** is computed, not stored: an image is outdated for rule R if it is in R's tag and its current version
  does not list R at R's current revision.

### Flow

1. **Tag and rule.** On the Board, select images, add them to a tag. In the tag's panel, write a rule: text + region.
   Every image in the tag shows `outdated: <rule>`.
2. **Apply.** Filter "Outdated", select up to 10, press **Apply rules**. The dialog lists the rules per image, the
   estimate (~2 min per image, plus auto-mask) and asks for 1-3 pilots. More than 10: refused, split it.
3. **Pilots.** Auto-mask + edit for the pilots only. The batch pauses at "Pilots ready". Accept: their results become
   style references. Reject: edit the rule or retry.
4. **Auto-mask the rest.** One Codex call for the whole batch: the images are attached, the reply is a JSON outline
   of the region per image, which becomes a mask (grown and feathered as today). "Whole image" rules skip this.
   Flagged masks pause their image.
5. **Generate.** The existing fixer, with the merged rules as the instruction, style refs + pilot results as
   references, and the version tagged with the rules it used. Runs on the server's queue in both agent modes (it is
   mechanical), with the M3 timeout, log and `job.json`.
6. **Review grid.** "Has candidate" filter, before/after per card, Accept selected / Reject selected. Accepted images
   stop being outdated; rejected ones stay outdated.

### Build order

| Step | Scope | Done when |
| --- | --- | --- |
| M5a Tags | `tags.json`, config `tags` with patterns, groups become tags; Board tag picker (replaces the group picker), New tag / Add to tag / Remove from tag on the selection; list sidebar by tag | Unit 01 shows under "Âu Lạc", "Tank" and "1★"; tags survive restart; tests |
| M5b Rules + outdated | Rules CRUD per tag with revisions; outdated chip + Board filter; rules recorded in versions; no generation yet | Saving a rule on "Tank" marks exactly the tank images outdated; editing it re-marks them |
| M5c Auto-mask spike | CLI `asset-studio automask <id...> --region "<words>"`: writes masks + overlays; run on the 13 1★ units for "the shield" and "the helmet" | Go if at least 10 of 13 masks are usable per region. No-go fallback: region rules need a painted mask, "whole image" rules still work |
| M5d Apply rules | Dialog, cap 10, pilots, pause/resume, auto-mask + checks, generation with refs, progress on cards | A rule on "1★" applied to 10 units end to end with 1 pilot |
| M5e Review grid | Before/after on cards (hover or slider), batch summary | 10 candidates reviewed and accepted/rejected in one screen |

### Risks

- **Auto-mask accuracy** is the big unknown (vision models are rough at outlines). M5c is a go/no-go spike before
  M5d is built on it.
- **Whole-image rules drift** (pose, face, proportions change). Pilots and the review grid catch it; nothing is written
  to the game until Accept.
- **Quota and time:** 10 images ≈ 20-25 min plus one auto-mask call. The cap keeps a mistaken select-all cheap.
- **Merged rules** can produce results nobody asked for; the per-version rule record is the way to debug it.

## 7. Original open questions (answered above)

1. **Repo:** a new git repo at `gamedev/asset-studio` (this folder), used by games as a dev dependency? Or a
   folder copied into each game?
2. **Agent:** Claude Code only (as now), or should the watcher also be able to drive Codex directly?
3. **Order:** start with M1 (move gameanmay over first, safest) or M2 (HOV raster first, most value now)?
4. **Sharing:** local only, like gameanmay, or later hosted so a teammate can mark up too?
