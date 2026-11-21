# Asset Studio

A local page for fixing game art by marking it up. Open an asset, paint a **mask** over what is wrong, drop numbered
**pins** with instructions, press **Send**. An agent edits the image, the result is pasted back **only inside the
mask** (nothing else can drift), and you slide between before and after, then **Accept** or **Reject**. Every
version is kept.

Inspired by the gameanmay Art Studio (SVG recipes edited by Claude); this one is game-agnostic and built for
AI-generated raster art. Local only (binds to 127.0.0.1).

## Use it in a game

1. Add `asset-studio.config.mjs` to the game root (example: Heroes of Vietnam,
   `gamecodaivailon/Vietnamese-dynasties-2/asset-studio.config.mjs`):

   ```js
   export default {
     name: "My game",
     agent: "claude",                 // or "codex"
     styleRefs: ["art/master/hero.png"],
     styleBlock: "art/prompts/style.txt",
     keyColor: [255, 0, 255],         // background the model sees, keyed out after
     groups: [{ id: "units", label: "Units", assets: [
       { id: "unit/archer", label: "Archer", file: "art/units/archer.png", scale: 1, brief: "what it is" },
     ] }],
   };
   ```

2. From the game root: `node <path-to>/asset-studio/bin/asset-studio.mjs dev`, open http://127.0.0.1:5180.
3. Add `.asset-studio/` to the game's `.gitignore` (local version history and feedback).

## Board: audit a whole group in one pass

The **Board** view shows a group (or all groups) as cards:

- **Filters** with counts: not reviewed, needs fix, in review, approved, has candidate, marked (mark-up not sent
  yet), fixing / failed.
- **Select** cards with their checkbox (Shift-click selects a range), or "Select shown".
- **Batch actions** on the selection: Approve, Needs fix, Accept candidates (writes the game files), Reject candidates.
- **Send all marked** sends every asset on the board that has unsent mark-up. **Send note to selected** sends each
  selected asset its own unsent mark-up plus one shared note (no mask means the whole image may change).
- Click a card for its details in the right panel (you stay on the Board); double-click to open it for mark-up.

Unsent mark-up is saved as a draft in `.asset-studio/drafts/`, so an audit survives a page reload.

## Generate new art: briefs, variant sets, overlay preview

Made for effects and icons (a burning flame, stun stars, status icons), but works for any new image.

**Generate from a brief.** An asset whose `file` does not exist yet shows as a **brief** card (✦) instead of an
error. Its panel shows the brief and a **Generate** button: Codex draws a new image from the brief (plus anything
written in the Note), on the key colour, and it comes back as a candidate to Accept or Reject. Accept creates the
game file (and its folder). On the Board, **Generate selected** does the same for up to 10 cards (the note box is
added to every one); the filter **Brief (no image)** lists what is left to make. A generate request is a Send
folder with `"mode": "generate"` in `notes.json`, so it uses the same queue, timeout, log, watcher and progress chip.

**Variant sets.** `variants: 4` makes Generate draw 4 different versions of the same subject in ONE image (2×2 grid;
5-6 use 3×2; unused cells stay empty), so they share size, style and palette. Focus shows the cells numbered. The
fixer checks each cell and the reply warns when a variant is empty or touches its cell edge. **Accept** writes the
sheet to `file` and each variant to `<stem>.<k>.png` (`burn_flame.png` → `burn_flame.1.png` … `burn_flame.4.png`).
**Redo one variant: k** sends a masked edit of cell k only, so the others cannot change.

**Overlay view.** Draws the selected asset on top of real sprites, at game size and zoomed, in every look from
`overlay.tints` (e.g. ally and the enemy tint), with motion: `flicker` swaps variants with a jitter (flames),
`orbit` circles them over the head (stun stars), `rise` floats them up and fades (embers), `icon: true` puts it
next to a health bar. It previews the candidate when there is one, so you judge it before accepting.

```js
export default {
  // ...
  overlay: {
    bases: ["unit/ad_u_01/s1", "unit/ad_u_03/s1", "hero/ad"],   // sprites to preview effects on
    baseHeight: 120,                                             // px, like in the game
    tints: [{ label: "Ally" }, { label: "Enemy", color: "#691216", alpha: 0.5 }],
  },
  groups: [{ id: "status-burn", label: "Status · Burn", assets: [
    { id: "fx/burn/flame", label: "Burn flame ×4", file: "art/master/fx/burn_flame.png",
      variants: 4,                                   // one 2×2 sheet, 512×512 per cell by default (`size`)
      styleBlock: "art/prompts/01-style-block-vfx.txt",   // effects need other rules than figures
      brief: "A single cut-paper flame tongue ...",
      overlay: { anchor: [0.5, 0.5], size: 0.38, motion: "flicker" } },
    { id: "fx/burn/icon", label: "Burn icon", file: "art/master/icons/status_burn.png", size: [256, 256],
      brief: "Status icon for BURNING ...", overlay: { icon: true } },
  ] }],
};
```

Per-asset fields: `variants` (1-6), `size` ([w, h] of one image or cell; default 1024×1024, or 512×512 per cell),
`styleBlock` (replaces the project's), `refs` (extra reference images), `overlay` (`on`, `anchor`, `size`, `motion`,
`count`, `icon`).

## Tags

An image can be in any number of tags (faction, role, tier, "map objects"...). A tag only lists asset ids; no image is
copied. Three kinds:

- **Groups** from the config are tags.
- **Config tags** pick members by id pattern: `*` stays inside one id segment, `**` matches anything.

  ```js
  tags: [
    { id: "tier-2", label: "2★", match: "unit/*/s2" },
    { id: "role-tank", label: "Tank", match: ["unit/ad_u_01/*", "unit/ad_u_08/*"] },
    { id: "map-objects", label: "Map objects", match: ["hq/**", "set/**"], assets: ["icon/ad_s_02"] },
  ],
  ```

- **Your tags**, made in the page: select cards on the Board, "Add selected to tag → New tag…". Rename, delete
  and remove members on the Board when the tag is shown, or with the × on a tag chip in the right panel. Stored in
  `.asset-studio/tags.json`.

The Board's picker shows any tag; the left list switches between "By group" and "By tag". CLI: `asset-studio tags
[<assetId>]`, `asset-studio tag new|add|remove|rename|delete ...`.

## Agents

| Mode | Who answers a Send | Set up |
| --- | --- | --- |
| `claude` | Claude Code, via the skill in `skill/asset-studio/SKILL.md` (copy it to the game's `.claude/skills/`). Claude reads your sketch, writes a precise instruction and runs `asset-studio fix`. Best for unclear or multi-pin feedback. | Ask Claude "start the studio" |
| `codex` | The studio server itself runs Codex CLI on each Send with your pin text. Fast, no conversation. | `agent: "codex"`, signed-in `codex` CLI |

Image edits always go through the Codex CLI's built-in image generation (`codex exec`, your subscription quota).

## Commands

```
asset-studio dev                      serve the page
asset-studio watch                    print NEW FEEDBACK: <folder> per unanswered Send
asset-studio pending                  list unanswered Sends
asset-studio accept|reject <id>       accept or reject the current candidate (same as the page buttons)
asset-studio request <id> --note <t> [--rect x0,y0,x1,y1]... [--ellipse ...] [--variant <k>]   file a Send from the CLI (agent batch fixes)
asset-studio generate <id>... [--note <t>]   file a Generate request per asset (draw from the brief)
asset-studio fix <folder> [--instruction <text>|--instruction-file <f>] [--agent claude|codex] [--dry-run]
asset-studio jobs [--all]             each Send's fix state: queued / running (stage + time, codex pid) / failed / interrupted
asset-studio log [-n <lines>]         tail of the studio log
```

## When a fix looks stuck

Every fix has a time limit: `fixTimeoutMin` in the config, default 10 minutes. After that the Codex process tree is
killed, the Send is marked failed and the queue moves on. The page shows the current stage and elapsed time
("codex: codex image edit (attempt 1) · 2m 10s"). For more detail:

1. `asset-studio jobs`, or the page's **Log** link (`/api/log`), shows which Send is stuck, in which stage and for how long.
2. `.asset-studio/logs/studio.log` is one log shared by the server, watcher and `fix` runs: every Send, stage, Codex
   start/exit/heartbeat (every 30 s), timeout, accept/reject and server error. It rotates at 5 MB.
3. `feedback/<id>/<stamp>/work/codex.log` holds Codex's full output for that Send, for each attempt.
4. `feedback/<id>/<stamp>/job.json` holds the job's live state. If the process that owned the job is gone, the page
   says "Interrupted"; send the asset again.

When someone reports a stuck job, ask them for `studio.log` and that Send's folder.

## Data (in the game repo, `.asset-studio/`)

- `assets/<id>/v<n>.png` + `meta.json`: versions, current, candidate, review status.
- `feedback/<id>/<stamp>/`: `notes.json`, `sketch.png`, `mask.png`, `photos/`, `before.png`, `status.json`,
  `ack.json`, `job.json` (fix state), `reply.json`, `work/` (prompts, `codex.log`, raw edit, composited result).
- `logs/studio.log`: the studio log (see above).
- `drafts/<id>.json`: unsent mark-up per asset.
- `tags.json`: tags made in the page.

## Limits

- The mask protects everything outside it. If the old object sticks out past your mask, its remains stay: paint
  the whole object (the fixer adds an 18 px margin).
- The edit model may shift what is inside the mask; reject and resend with a sharper pin.
- No hosting or multi-user; no frame-by-frame animation stage (see `docs/PLAN.md`, M4): effects are variant sets
  animated by the game (swap, jitter, drift), previewed in the Overlay view.
- Image models draw grids loosely: a variant may cross its cell or one cell may stay empty. The reply warns; use
  **Redo one variant** or Generate again.

## Develop

`npm install`, `npm test`, `npm run typecheck`.
