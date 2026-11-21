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
asset-studio request <id> --note <t> [--rect x0,y0,x1,y1]... [--ellipse ...]   file a Send from the CLI (agent batch fixes)
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
- No hosting or multi-user; no animation-frame stage yet (see `docs/PLAN.md`, M3-M4).

## Develop

`npm install`, `npm test`, `npm run typecheck`.
