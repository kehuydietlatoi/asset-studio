---
name: asset-studio
description: Run the Asset Studio live art-fix loop with the owner. Use when the owner says "start the studio", "check the studio", "I sent feedback", or wants to mark up and fix game art (AI images) in real time. Starts the studio, watches for Sends, answers each one with a masked Codex image edit, and replies in the page.
---

# Asset Studio loop (Claude mode)

The owner marks up an asset at http://127.0.0.1:5180 (red **mask** = the only area allowed to change, numbered
**pins** with instructions, pen/arrows for explanation, reference photos) and presses **Send**. You turn that into a
precise edit, run the fixer, and the owner compares and accepts or rejects the candidate in the page.

`<studio>` below is the asset-studio checkout (e.g. `../asset-studio` from a game repo). Run every command from the
game repo root (the folder with `asset-studio.config.mjs`).

1. **Start.** `node <studio>/bin/asset-studio.mjs dev` in the background (Bash `run_in_background`). Give the owner the
   URL. Port 5180 by default (`port` in the config).
2. **Watch.** Run `node <studio>/bin/asset-studio.mjs watch` with the Monitor tool. It prints
   `NEW FEEDBACK: <folder>` per Send and writes `ack.json` (by watcher) so the page says "Received".
   A Board batch ("Send all marked", "Send note to selected") arrives as several `NEW FEEDBACK` lines, one folder per
   asset: answer them one at a time, oldest first, each with its own `fix`. Notes from "Send note to selected" are
   the same text on every asset; still read each sketch, the right edit differs per image.
3. **Read the Send** in `<folder>`: `notes.json` (pins with text, general note), `sketch.png` (what the owner saw with
   their mark-up: look at it), `mask.png` (white = may change), `photos/`, `before.png`.
4. **Write the instruction.** One short paragraph per pin: what to remove, what to put there, what must stay. Use the
   asset's role and the game's rules (style block, banned motifs). If a pin is ambiguous or the mask clearly misses the
   thing the pin talks about, do not edit: write `reply.json` with `"status": "question"` and ask.
5. **Fix.** `node <studio>/bin/asset-studio.mjs fix "<folder>" --agent claude --instruction "<text>"`
   (or `--instruction-file`). It runs Codex image generation, composites the result back only inside the mask,
   stores a candidate version and writes `reply.json`. Takes 1-3 minutes.
6. **Check before the owner does.** Read `<folder>/work/edit-raw.png` and the candidate
   (`.asset-studio/assets/<id with / as __>/v<n>.png`). If the edit ignored the instruction or broke the style, run
   `fix` again with a sharper instruction (it makes a new candidate). If parts of the old object survive at the mask
   edge, reply asking the owner to paint the mask wider.
   If `fix` fails or times out (`fixTimeoutMin`, default 10 min), read the error, then `asset-studio log -n 40` and
   `<folder>/work/codex.log`. Retry once if it looks transient; otherwise write `reply.json` with `"status": "wont"`
   and the reason, so the page stops showing the job as running.
7. **Reply in one terminal line** too: what changed, which version to compare.
8. Accepting writes the game file (`file` in the config). Commit game assets only when the owner asks.

Codex mode (`agent: "codex"` in the config): the server runs step 5 by itself with the pins' text as the
instruction; no watcher or Claude needed.
