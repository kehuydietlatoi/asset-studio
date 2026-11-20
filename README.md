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
asset-studio fix <folder> [--instruction <text>|--instruction-file <f>] [--agent claude|codex] [--dry-run]
```

## Data (in the game repo, `.asset-studio/`)

- `assets/<id>/v<n>.png` + `meta.json`: versions, current, candidate, review status.
- `feedback/<id>/<stamp>/`: `notes.json`, `sketch.png`, `mask.png`, `photos/`, `before.png`, `status.json`,
  `ack.json`, `reply.json`, `work/` (prompts, raw edit, composited result).

## Limits

- The mask protects everything outside it. If the old object sticks out past your mask, its remains stay: paint
  the whole object (the fixer adds an 18 px margin).
- The edit model may shift what is inside the mask; reject and resend with a sharper pin.
- No hosting or multi-user; no animation-frame stage yet (see `docs/PLAN.md`, M3-M4).

## Develop

`npm install`, `npm test`, `npm run typecheck`.
