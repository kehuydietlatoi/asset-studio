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

## 5. Owner decisions (2026-11-20)

- New standalone repo, no dependency on gameanmay; reuse the ideas, rebuild code as needed.
- Both agents: Claude (skill + watcher) and Codex (server runs the fixer itself).
- Start with what helps Heroes of Vietnam most: M2 first (raster fixer, versions, line-up). M1 (moving gameanmay
  over) is now optional.
- Local only.

Status: M2 core built and tested end to end on HOV unit AD_U_11 (masked crest swap). Board view and status chips
exist in a first form; batch "send all marked" is still to do (M3).

## 6. Original open questions (answered above)

1. **Repo:** a new git repo at `gamedev/asset-studio` (this folder), used by games as a dev dependency? Or a
   folder copied into each game?
2. **Agent:** Claude Code only (as now), or should the watcher also be able to drive Codex directly?
3. **Order:** start with M1 (move gameanmay over first, safest) or M2 (HOV raster first, most value now)?
4. **Sharing:** local only, like gameanmay, or later hosted so a teammate can mark up too?
