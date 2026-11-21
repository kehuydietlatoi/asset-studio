/** Asset Studio page: pick an asset, mark it up, Send, then compare and accept the agent's candidate. */

type Version = { n: number; at: string; source: string; parent?: number; prompt?: string; agent?: string };
type Meta = { id: string; status: string; current: number; candidate: number | null; versions: Version[] };
type AssetRow = { id: string; label: string; scale: number; meta: Meta | null; job: string | null };
type Group = { id: string; label: string; assets: AssetRow[] };
type Tag = { id: string; label: string; kind: "group" | "config" | "user"; assets: string[] };
type Project = { name: string; agent: string; stage: { sky?: string; ground?: string; groundY?: number }; groups: Group[]; tags: Tag[] };
type ReplyNote = { pin: number | null; status: "fixed" | "question" | "wont"; text: string };
type Feedback = { folder: string; ack: { by: string } | null; reply: { summary: string; notes: ReplyNote[]; candidate?: number } | null; job: string | null };

type Pt = [number, number];
type Item =
  | { kind: "mask" | "pen"; w: number; pts: Pt[] }
  | { kind: "arrow"; a: Pt; b: Pt }
  | { kind: "pin"; x: number; y: number; text: string };
/** `sent`: this mark-up went out unchanged; any edit makes it "marked" (unsent) again. */
type Markup = { items: Item[]; notes: string; photos: string[]; sent?: boolean };
type PinItem = Extract<Item, { kind: "pin" }>;
type Tool = "mask" | "pin" | "pen" | "arrow";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLCanvasElement>("stage");
const g = stage.getContext("2d")!;
const lineup = $<HTMLCanvasElement>("lineup");

let project: Project | null = null;
let selId: string | null = null;
let view: "focus" | "lineup" | "board" = "focus";
let tool: Tool = "mask";
let viewVersion: number | null = null; // null = current
let compare = false;
let slider = 0.5;
let lastFeedback: Feedback | null = null;
const markups = new Map<string, Markup>();
const images = new Map<string, HTMLImageElement>();

const STATUS_LABEL: Record<string, string> = { generated: "generated", in_review: "in review", needs_fix: "needs fix", approved: "approved" };

// ------------------------------------------------------------------ data

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

function imgUrl(id: string, v: number) {
  return `/api/image?asset=${encodeURIComponent(id)}&v=${v}`;
}

function loadImage(url: string): HTMLImageElement {
  let im = images.get(url);
  if (!im) {
    im = new Image();
    im.src = url;
    im.onload = () => render();
    images.set(url, im);
  }
  return im;
}

const allAssets = () => project?.groups.flatMap((gr) => gr.assets) ?? [];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const tagById = (id: string) => project?.tags.find((t) => t.id === id) ?? null;
/** Tags of an asset; `withGroups` false leaves out its config group (already shown by the list). */
const tagsOfAsset = (id: string, withGroups = true) => (project?.tags ?? []).filter((t) => (withGroups || t.kind !== "group") && t.assets.includes(id));
const userTags = () => (project?.tags ?? []).filter((t) => t.kind === "user");

async function tagOp(body: Record<string, unknown>, done: string) {
  try {
    await api("/tag", body);
    toast(done);
  } catch (e) {
    toast((e as Error).message);
  }
  await refreshProject();
}

/** Asks for a name and creates a user tag holding `assets`. Returns the new tag id (or null). */
async function newTag(assets: string[]): Promise<string | null> {
  const label = prompt(`Name of the new tag${assets.length ? ` (${assets.length} asset(s) go in)` : ""}:`)?.trim();
  if (!label) return null;
  try {
    const t = await api<Tag>("/tag", { op: "create", label, assets });
    toast(`Tag "${t.label}" created`);
    await refreshProject();
    return t.id;
  } catch (e) {
    toast((e as Error).message);
    return null;
  }
}

/** Options for an "add to tag" select: every user tag + "New tag…". */
const addTagOptions = (first: string) =>
  `<option value="">${first}</option>` + userTags().map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join("") + `<option value="__new">＋ New tag…</option>`;
const sel = () => allAssets().find((a) => a.id === selId) ?? null;
const groupOfSel = () => project?.groups.find((gr) => gr.assets.some((a) => a.id === selId)) ?? null;
function markup(id = selId): Markup {
  if (!id) return { items: [], notes: "", photos: [] };
  let m = markups.get(id);
  if (!m) markups.set(id, (m = { items: [], notes: "", photos: [] }));
  return m;
}
const pinsOf = (m: Markup) => m.items.filter((i): i is PinItem => i.kind === "pin");
const hasMarkup = (m: Markup | undefined) => !!m && (pinsOf(m).length > 0 || m.notes.trim() !== "");
/** Has mark-up that has not been sent yet. */
const isMarked = (id: string) => hasMarkup(markups.get(id)) && !markups.get(id)!.sent;

// Drafts: unsent mark-up is saved on the server (debounced), so a long audit survives a reload.
const saveTimers = new Map<string, number>();
function saveDraft(id: string) {
  clearTimeout(saveTimers.get(id));
  saveTimers.set(
    id,
    window.setTimeout(() => {
      const m = markups.get(id);
      const empty = !m || (!m.items.length && !m.notes.trim() && !m.photos.length);
      api("/draft", { asset: id, draft: empty ? null : m }).catch((e) => toast(`Draft not saved: ${(e as Error).message}`));
      renderList();
    }, 600),
  );
}
/** Call after every edit of the selected asset's mark-up. */
function touch(id = selId) {
  if (!id) return;
  markup(id).sent = false;
  saveDraft(id);
}
function forget(id: string) {
  markups.delete(id);
  saveDraft(id);
}

async function refreshProject() {
  project = await api<Project>("/project");
  $("projectName").textContent = project.name;
  $("agentBadge").textContent = `agent: ${project.agent}`;
  renderList();
  renderPanel();
  if (view !== "focus") render();
}

function toast(s: string) {
  $("toast").textContent = s;
  setTimeout(() => ($("toast").textContent === s ? ($("toast").textContent = "") : 0), 4000);
}

// ------------------------------------------------------------------ list + board

function chip(a: AssetRow): string {
  if (a.job) {
    // Full text (stage, elapsed, queue place) on hover; the list only has room for the gist.
    const short = a.job.startsWith("Fix failed") ? "fix failed" : a.job.startsWith("Interrupted") ? "interrupted" : a.job.startsWith("Queued") ? "queued" : "fixing…";
    return `<span class="chip job" title="${esc(a.job)}">${short}</span>`;
  }
  const s = a.meta?.status ?? "generated";
  const cand = a.meta?.candidate ? ` · v${a.meta.candidate} ready` : "";
  return `<span class="chip ${s}">${STATUS_LABEL[s] ?? s}${cand}</span>`;
}

const markedBadge = (id: string) => {
  if (!isMarked(id)) return "";
  const n = pinsOf(markups.get(id)!).length;
  return `<span class="marked" title="Marked, not sent yet">✎${n ? ` ${n}` : ""}</span>`;
};

/** Left list: by config group (one place per asset) or by tag (an asset shows under each of its tags). */
let listMode: "group" | "tag" = "group";
try {
  if (localStorage.getItem("asset-studio.listMode") === "tag") listMode = "tag";
} catch {
  /* storage blocked: default */
}

function renderList() {
  if (!project) return;
  const row = (a: AssetRow) =>
    `<div class="asset ${a.id === selId ? "sel" : ""}" data-id="${a.id}"><img src="${a.meta ? imgUrl(a.id, a.meta.current) : ""}" alt="" /><span class="lbl">${esc(a.label)}</span>${markedBadge(a.id)}${chip(a)}</div>`;
  const section = (label: string, rows: AssetRow[], kind = "") =>
    `<div class="group"><h3>${kind ? `<span class="tk ${kind}" title="${kind === "user" ? "tag made in the page" : "tag from the config"}"></span>` : ""}${esc(label)} (${rows.length})</h3>${rows.map(row).join("")}</div>`;
  const toggle = `<div class="listMode"><button data-list="group" class="${listMode === "group" ? "on" : ""}">By group</button><button data-list="tag" class="${listMode === "tag" ? "on" : ""}">By tag</button></div>`;
  let body: string;
  if (listMode === "group") body = project.groups.map((gr) => section(gr.label, gr.assets)).join("");
  else {
    const byId = new Map(allAssets().map((a) => [a.id, a]));
    const tags = project.tags.filter((t) => t.kind !== "group");
    const tagged = new Set(tags.flatMap((t) => t.assets));
    const untagged = allAssets().filter((a) => !tagged.has(a.id));
    body = tags.length
      ? tags.map((t) => section(t.label, t.assets.map((id) => byId.get(id)!).filter(Boolean), t.kind)).join("") + (untagged.length ? section("Untagged", untagged) : "")
      : `<p class="hint">No tags yet. Select cards on the Board and use "Add to tag", or add <code>tags</code> to the config.</p>`;
  }
  $("assetList").innerHTML = toggle + body;
  if (view === "board") renderBoard();
}

// ------------------------------------------------------------------ board (M3: audit a whole group in one pass)

/** "" = the selected asset's group, "*" = every asset, else a tag id (groups are tags too). */
let boardGroup = "";
let boardFilter = "all";
const picked = new Set<string>();
let lastPick: string | null = null;
let batchBusy = false;

const FILTERS: { id: string; label: string; test: (a: AssetRow) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "generated", label: "Not reviewed", test: (a) => (a.meta?.status ?? "generated") === "generated" },
  { id: "needs_fix", label: "Needs fix", test: (a) => a.meta?.status === "needs_fix" },
  { id: "in_review", label: "In review", test: (a) => a.meta?.status === "in_review" },
  { id: "approved", label: "Approved", test: (a) => a.meta?.status === "approved" },
  { id: "candidate", label: "Has candidate", test: (a) => !!a.meta?.candidate },
  { id: "marked", label: "Marked, not sent", test: (a) => isMarked(a.id) },
  { id: "job", label: "Fixing / failed", test: (a) => !!a.job },
];

function boardPool(): AssetRow[] {
  if (!project) return [];
  if (boardGroup === "*") return allAssets();
  const tag = boardGroup ? tagById(boardGroup) : null;
  if (tag) {
    const byId = new Map(allAssets().map((a) => [a.id, a]));
    return tag.assets.map((id) => byId.get(id)!).filter(Boolean);
  }
  return (groupOfSel() ?? project.groups[0])?.assets ?? [];
}
const boardShown = () => boardPool().filter((FILTERS.find((f) => f.id === boardFilter) ?? FILTERS[0]).test);
const pickedRows = () => allAssets().filter((a) => picked.has(a.id));

function renderBoard() {
  if (!project) return;
  if (boardGroup && boardGroup !== "*" && !tagById(boardGroup)) boardGroup = ""; // tag deleted meanwhile
  const groupSel = $<HTMLSelectElement>("boardGroup");
  const optsOf = (kind: Tag["kind"], title: string) => {
    const ts = project!.tags.filter((t) => t.kind === kind);
    return ts.length ? `<optgroup label="${title}">${ts.map((t) => `<option value="${esc(t.id)}">${esc(t.label)} (${t.assets.length})</option>`).join("")}</optgroup>` : "";
  };
  const opts =
    `<option value="">Group of the selected asset</option><option value="*">All assets (${allAssets().length})</option>` +
    optsOf("group", "Groups") +
    optsOf("config", "Tags (config)") +
    optsOf("user", "My tags");
  if (groupSel.dataset.opts !== opts) {
    groupSel.innerHTML = opts;
    groupSel.dataset.opts = opts;
  }
  groupSel.value = boardGroup;

  // Tag tools: add the selection to a tag; manage the tag on screen when it is a user tag.
  const shownTag = boardGroup ? tagById(boardGroup) : null;
  const addSel = $<HTMLSelectElement>("bTagAdd");
  const addOpts = addTagOptions("Add selected to tag…");
  if (addSel.dataset.opts !== addOpts) {
    addSel.innerHTML = addOpts;
    addSel.dataset.opts = addOpts;
  }
  const own = shownTag?.kind === "user";
  for (const id of ["bTagRemove", "bTagRename", "bTagDelete"]) $(id).classList.toggle("hidden", !own);
  $("bTagInfo").textContent = shownTag && shownTag.kind !== "user" ? `"${shownTag.label}" comes from the config (edit it there)` : "";

  const pool = boardPool();
  $("boardFilters").innerHTML = FILTERS.map((f) => {
    const n = pool.filter(f.test).length;
    return `<button data-filter="${f.id}" class="${f.id === boardFilter ? "on" : ""}" ${n || f.id === "all" ? "" : "disabled"}>${f.label} <small>${n}</small></button>`;
  }).join("");

  const chosen = pickedRows();
  const marked = pool.filter((a) => isMarked(a.id));
  $("bCount").textContent = `${chosen.length} selected`;
  $("bSendMarked").textContent = `Send all marked (${marked.length})`;
  $("bSendNote").textContent = `Send note to selected (${chosen.length})`;
  for (const id of ["bApprove", "bNeedsFix", "bAccept", "bReject", "bSendNote", "bTagRemove"]) ($(id) as HTMLButtonElement).disabled = batchBusy || !chosen.length;
  addSel.disabled = batchBusy || !chosen.length;
  ($("bAccept") as HTMLButtonElement).disabled ||= !chosen.some((a) => a.meta?.candidate);
  ($("bReject") as HTMLButtonElement).disabled ||= !chosen.some((a) => a.meta?.candidate);
  ($("bSendMarked") as HTMLButtonElement).disabled = batchBusy || !marked.length;

  const shown = boardShown();
  $("board").innerHTML = shown.length
    ? shown
        .map(
          (a) =>
            `<div class="card ${picked.has(a.id) ? "picked" : ""} ${a.id === selId ? "sel" : ""}" data-id="${a.id}" title="Click: details on the right · Double-click: open to mark up">` +
            `<input type="checkbox" class="pick" data-pick="${a.id}" ${picked.has(a.id) ? "checked" : ""} title="Select (Shift: range)" />` +
            `<img src="${a.meta ? imgUrl(a.id, a.meta.candidate ?? a.meta.current) : ""}" alt="" />` +
            `<div class="lbl">${esc(a.label)}</div>` +
            (() => {
              const ts = tagsOfAsset(a.id, false);
              return ts.length ? `<div class="tags">${ts.map((t) => `<span class="tag ${t.kind}">${esc(t.label)}</span>`).join("")}</div>` : "";
            })() +
            `<div class="meta">${chip(a)}${markedBadge(a.id)}<span>${a.meta ? `v${a.meta.candidate ?? a.meta.current}${a.meta.candidate ? " (cand.)" : ""}` : "missing"}</span></div></div>`,
        )
        .join("")
    : `<div class="empty">No assets match this filter.</div>`;
}

function pick(id: string, on: boolean, range: boolean) {
  const shown = boardShown().map((a) => a.id);
  const ids = range && lastPick && shown.includes(lastPick) ? shown.slice(Math.min(shown.indexOf(lastPick), shown.indexOf(id)), Math.max(shown.indexOf(lastPick), shown.indexOf(id)) + 1) : [id];
  for (const x of ids) on ? picked.add(x) : picked.delete(x);
  lastPick = id;
  renderBoard();
}

async function runBatch(action: "approve" | "needs_fix" | "accept" | "reject") {
  const ids = pickedRows().map((a) => a.id);
  if (!ids.length) return toast("Select assets first");
  if (action === "accept" && !confirm(`Accept the candidate of ${ids.length} asset(s)? This writes the game files (older versions stay in the history).`)) return;
  batchBusy = true;
  renderBoard();
  try {
    const { results } = await api<{ results: { id: string; ok: boolean; detail: string }[] }>("/batch", { action, assets: ids });
    if (action === "accept") results.filter((r) => r.ok).forEach((r) => forget(r.id));
    const skipped = results.filter((r) => !r.ok);
    toast(`${results.length - skipped.length} done${skipped.length ? `, ${skipped.length} skipped (${skipped[0].detail}${skipped.length > 1 ? ", …" : ""})` : ""}`);
  } catch (e) {
    toast((e as Error).message);
  } finally {
    batchBusy = false;
    await refreshProject();
  }
}

/** Send many assets one after another; one failure does not stop the rest. */
async function sendMany(rows: AssetRow[], extraNote: string, what: string) {
  if (!rows.length) return;
  const noMask = rows.filter((a) => !(isMarked(a.id) && markups.get(a.id)!.items.some((i) => i.kind === "mask"))).length;
  const warn = noMask ? `\n\n${noMask} of them have no mask: the agent may change the whole image there.` : "";
  if (!confirm(`Send ${rows.length} asset(s) to the agent (${what})?${warn}`)) return;
  batchBusy = true;
  const failed: string[] = [];
  for (const [i, a] of rows.entries()) {
    $("bProgress").textContent = `Sending ${i + 1}/${rows.length}: ${a.label}…`;
    renderBoard();
    try {
      // Mark-up already sent is not sent again; such an asset only gets the shared note (whole image, no mask).
      await sendAsset(a, isMarked(a.id) ? markups.get(a.id)! : { items: [], notes: "", photos: [] }, extraNote);
    } catch (e) {
      failed.push(`${a.label}: ${(e as Error).message}`);
    }
  }
  batchBusy = false;
  $("bProgress").textContent = failed.length ? `Sent ${rows.length - failed.length}/${rows.length}. Not sent: ${failed.join(" · ")}` : `Sent ${rows.length} asset(s). Progress shows on each card.`;
  lastReplyKey = "";
  await refreshProject();
  pollFeedback();
}

/** Select an asset; `open` switches to Focus (list clicks do, a single click on a Board card does not). */
function select(id: string, open = true) {
  selId = id;
  viewVersion = null;
  compare = false;
  ($("compare") as HTMLInputElement).checked = false;
  lastFeedback = null;
  renderList();
  renderPanel();
  pollFeedback();
  if (open) setView("focus");
}

// ------------------------------------------------------------------ panel

function renderPanel() {
  const a = sel();
  $("assetTitle").textContent = a ? a.label : "Pick an asset";
  const m = markup();
  const s = a?.meta?.status ?? "";
  $("statusChip").className = `chip ${s}`;
  $("statusChip").textContent = a ? STATUS_LABEL[s] ?? s : "";
  const tagsHtml = a
    ? tagsOfAsset(a.id)
        .map(
          (t) =>
            `<span class="tag ${t.kind}" title="${t.kind === "user" ? "tag made in the page" : t.kind === "group" ? "group from the config" : "tag from the config"}">${esc(t.label)}${t.kind === "user" ? `<button class="x" data-untag="${esc(t.id)}" title="Remove from this tag">×</button>` : ""}</span>`,
        )
        .join("") + `<select id="panelTagAdd">${addTagOptions("+ tag")}</select>`
    : "";
  if ($("assetTags").dataset.html !== tagsHtml) {
    $("assetTags").innerHTML = tagsHtml;
    $("assetTags").dataset.html = tagsHtml;
  }
  const pins = m.items.filter((i): i is Extract<Item, { kind: "pin" }> => i.kind === "pin");
  const replyFor = (n: number) => lastFeedback?.reply?.notes.find((r) => r.pin === n);
  // Do not rebuild the inputs under the cursor while the owner types (periodic refresh), unless pins were added/removed.
  const typing = document.activeElement?.closest("#pins, #notes");
  if (!typing || $("pins").querySelectorAll("input").length !== pins.length) $("pins").innerHTML = pins
    .map((p, i) => {
      const r = replyFor(i + 1);
      return `<li><input data-pin="${i}" value="${p.text.replace(/"/g, "&quot;")}" placeholder="What should change here?" />${r ? `<div class="reply st-${r.status}">${r.status}: ${r.text}</div>` : ""}</li>`;
    })
    .join("");
  if (!typing) ($("notes") as HTMLTextAreaElement).value = m.notes;
  $("photos").innerHTML = m.photos.map((p, i) => `<img src="${p}" data-photo="${i}" title="Click to remove" />`).join("");

  const meta = a?.meta;
  const cand = meta?.candidate ?? null;
  $("candidate").classList.toggle("hidden", !cand);
  if (cand) $("candTitle").textContent = `Candidate v${cand} (current v${meta!.current}). Tick "Compare" to slide between them.`;
  $("versions").innerHTML = (meta?.versions ?? [])
    .slice()
    .reverse()
    .map(
      (v) =>
        `<li><span class="${v.n === meta!.current ? "cur" : ""}">v${v.n} · ${v.source}${v.agent ? ` (${v.agent})` : ""}${v.n === meta!.current ? " · current" : ""}${v.n === cand ? " · candidate" : ""}</span>` +
        `<button data-view-v="${v.n}">View</button>${v.n !== meta!.current ? `<button data-revert="${v.n}">Use</button>` : ""}</li>`,
    )
    .join("");
  renderReply();
}

function renderReply() {
  const f = lastFeedback;
  const state = $("sendState");
  if (!f) {
    state.textContent = "";
    $("reply").classList.add("hidden");
    return;
  }
  if (f.reply) state.textContent = `Answered (${f.folder})`;
  else if (f.job) state.textContent = f.job;
  else if (f.ack) state.textContent = f.ack.by === "watcher" ? "Received, waiting for the agent…" : `${f.ack.by} is working on it…`;
  else state.textContent = "Sent, waiting for the agent…";
  $("reply").classList.toggle("hidden", !f.reply);
  if (f.reply) {
    const general = f.reply.notes.filter((n) => n.pin == null);
    $("reply").innerHTML = `<strong>${f.reply.summary}</strong>` + general.map((n) => `<div class="st-${n.status}">${n.status}: ${n.text}</div>`).join("");
  }
}

let lastReplyKey = "";
async function pollFeedback() {
  if (!selId) return;
  try {
    const f = await api<Feedback | null>(`/feedback?asset=${encodeURIComponent(selId)}`);
    const key = JSON.stringify(f);
    if (key !== lastReplyKey) {
      lastReplyKey = key;
      lastFeedback = f;
      if (f?.reply) await refreshProject();
      else renderPanel();
    }
  } catch {
    /* server restarting */
  }
}

// ------------------------------------------------------------------ stage drawing

function currentImage(): HTMLImageElement | null {
  const a = sel();
  if (!a?.meta) return null;
  return loadImage(imgUrl(a.id, viewVersion ?? a.meta.current));
}

function drawMarkup(ctx: CanvasRenderingContext2D, W: number, H: number, m = markup()) {
  const masks = m.items.filter((i) => i.kind === "mask");
  if (masks.length) {
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const o = off.getContext("2d")!;
    o.strokeStyle = o.fillStyle = "#ff2a2a";
    o.lineCap = o.lineJoin = "round";
    for (const s of masks) strokePath(o, s as Extract<Item, { kind: "mask" }>);
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.drawImage(off, 0, 0);
    ctx.restore();
  }
  ctx.lineCap = ctx.lineJoin = "round";
  let pin = 0;
  for (const it of m.items) {
    if (it.kind === "pen") {
      ctx.strokeStyle = "#ffd23f";
      strokePath(ctx, it);
    } else if (it.kind === "arrow") {
      ctx.strokeStyle = ctx.fillStyle = "#3fd0ff";
      ctx.lineWidth = Math.max(4, W / 200);
      ctx.beginPath();
      ctx.moveTo(...it.a);
      ctx.lineTo(...it.b);
      ctx.stroke();
      const ang = Math.atan2(it.b[1] - it.a[1], it.b[0] - it.a[0]), h = W / 40;
      ctx.beginPath();
      ctx.moveTo(...it.b);
      ctx.lineTo(it.b[0] - h * Math.cos(ang - 0.45), it.b[1] - h * Math.sin(ang - 0.45));
      ctx.lineTo(it.b[0] - h * Math.cos(ang + 0.45), it.b[1] - h * Math.sin(ang + 0.45));
      ctx.fill();
    } else if (it.kind === "pin") {
      pin++;
      const r = W / 45;
      ctx.fillStyle = "#e0a64b";
      ctx.strokeStyle = "#1d1a17";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(it.x, it.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#1d1a17";
      ctx.font = `bold ${Math.round(r * 1.2)}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(pin), it.x, it.y + 1);
    }
  }
}

function strokePath(ctx: CanvasRenderingContext2D, s: { w: number; pts: Pt[]; kind: string }) {
  ctx.lineWidth = s.kind === "pen" ? 6 : s.w;
  if (s.pts.length === 1) {
    ctx.beginPath();
    ctx.arc(s.pts[0][0], s.pts[0][1], ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(...s.pts[0]);
  for (const p of s.pts.slice(1)) ctx.lineTo(...p);
  ctx.stroke();
}

function renderFocus() {
  const im = currentImage();
  if (!im || !im.complete || !im.naturalWidth) {
    g.clearRect(0, 0, stage.width, stage.height);
    return;
  }
  const W = im.naturalWidth, H = im.naturalHeight;
  if (stage.width !== W || stage.height !== H) {
    stage.width = W;
    stage.height = H;
  }
  fitStage();
  g.clearRect(0, 0, W, H);
  const a = sel()!;
  const cand = a.meta?.candidate;
  if (compare && cand) {
    const after = loadImage(imgUrl(a.id, cand));
    const before = loadImage(imgUrl(a.id, a.meta!.current));
    const x = Math.round(W * slider);
    g.save();
    g.beginPath();
    g.rect(0, 0, x, H);
    g.clip();
    if (before.complete) g.drawImage(before, 0, 0, W, H);
    g.restore();
    g.save();
    g.beginPath();
    g.rect(x, 0, W - x, H);
    g.clip();
    if (after.complete) g.drawImage(after, 0, 0, W, H);
    g.restore();
    g.fillStyle = "#e0a64b";
    g.fillRect(x - 2, 0, 4, H);
    g.font = `bold ${W / 40}px system-ui`;
    g.fillText(`v${a.meta!.current}`, 12, W / 30);
    g.fillText(`v${cand}`, W - W / 12, W / 30);
  } else {
    g.drawImage(im, 0, 0);
  }
  drawMarkup(g, W, H);
}

function fitStage() {
  const z = ($("zoom") as HTMLSelectElement).value;
  const wrap = $("stageWrap");
  let scale: number;
  if (z === "fit") scale = Math.min((wrap.clientWidth - 20) / stage.width, (wrap.clientHeight - 20) / stage.height);
  else scale = Number(z);
  stage.style.width = `${Math.round(stage.width * scale)}px`;
  stage.style.height = `${Math.round(stage.height * scale)}px`;
}

function renderLineup() {
  const gr = groupOfSel() ?? project?.groups[0];
  if (!gr || !project) return;
  const ctx = lineup.getContext("2d")!;
  const W = lineup.width, H = lineup.height;
  const gy = Math.round(H * (project.stage.groundY ?? 0.82));
  ctx.fillStyle = project.stage.sky ?? "#e6d6b0";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = project.stage.ground ?? "#8c7350";
  ctx.fillRect(0, gy, W, H - gy);
  const n = gr.assets.length;
  const base = Math.min(300, (W / Math.max(1, n)) * 1.6);
  gr.assets.forEach((a, i) => {
    if (!a.meta) return;
    const im = loadImage(imgUrl(a.id, a.meta.current));
    const h = base * a.scale;
    const cx = (W / (n + 1)) * (i + 1);
    if (im.complete && im.naturalWidth) ctx.drawImage(im, cx - h / 2, gy - h * 0.977, h, h);
    if (a.id === selId) {
      ctx.fillStyle = "#e0a64b";
      ctx.fillRect(cx - 30, gy + 8, 60, 6);
    }
  });
}

function render() {
  if (view === "focus") renderFocus();
  else if (view === "lineup") renderLineup();
}

function setView(v: typeof view) {
  view = v;
  document.querySelectorAll<HTMLButtonElement>("#views button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  $("stageWrap").classList.toggle("hidden", v !== "focus");
  $("toolbar").classList.toggle("hidden", v !== "focus");
  $("lineupWrap").classList.toggle("hidden", v !== "lineup");
  $("board").classList.toggle("hidden", v !== "board");
  $("boardBar").classList.toggle("hidden", v !== "board");
  if (v === "board") renderBoard();
  render();
}

// ------------------------------------------------------------------ input on the stage

function toImage(e: PointerEvent): Pt {
  const r = stage.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * stage.width, ((e.clientY - r.top) / r.height) * stage.height];
}

let drawing: Item | null = null;
stage.addEventListener("pointerdown", (e) => {
  if (!sel()) return;
  stage.setPointerCapture(e.pointerId);
  const p = toImage(e);
  if (compare) {
    slider = p[0] / stage.width;
    render();
    return;
  }
  const brush = Number(($("brush") as HTMLInputElement).value) * (stage.width / 1024);
  if (tool === "pin") {
    e.preventDefault(); // otherwise the browser moves focus to the canvas after this handler
    markup().items.push({ kind: "pin", x: p[0], y: p[1], text: "" });
    touch();
    renderPanel();
    render();
    setTimeout(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>("#pins input");
      inputs[inputs.length - 1]?.focus();
    }, 0);
    return;
  }
  drawing = tool === "arrow" ? { kind: "arrow", a: p, b: p } : { kind: tool, w: brush, pts: [p] };
  markup().items.push(drawing);
  render();
});
stage.addEventListener("pointermove", (e) => {
  if (compare && e.buttons) {
    slider = toImage(e)[0] / stage.width;
    render();
    return;
  }
  if (!drawing) return;
  const p = toImage(e);
  if (drawing.kind === "arrow") drawing.b = p;
  else if (drawing.kind === "mask" || drawing.kind === "pen") drawing.pts.push(p);
  render();
});
stage.addEventListener("pointerup", () => {
  if (drawing) touch();
  drawing = null;
});

// ------------------------------------------------------------------ send

function whenLoaded(im: HTMLImageElement): Promise<HTMLImageElement> {
  if (im.complete && im.naturalWidth) return Promise.resolve(im);
  return new Promise((res, rej) => {
    im.addEventListener("load", () => res(im), { once: true });
    im.addEventListener("error", () => rej(new Error("image failed to load")), { once: true });
  });
}

/** Sketch (current version + mark-up) and mask (white = may change) of any asset, without touching the stage. */
async function exportFor(a: AssetRow, m: Markup): Promise<{ sketch: string; mask: string | null }> {
  const im = await whenLoaded(loadImage(imgUrl(a.id, a.meta!.current)));
  const W = im.naturalWidth, H = im.naturalHeight;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(im, 0, 0);
  drawMarkup(ctx, W, H, m);
  const masks = m.items.filter((i): i is Extract<Item, { kind: "mask" }> => i.kind === "mask");
  if (!masks.length) return { sketch: c.toDataURL("image/png"), mask: null };
  const off = document.createElement("canvas");
  off.width = W;
  off.height = H;
  const o = off.getContext("2d")!;
  o.fillStyle = "#000";
  o.fillRect(0, 0, W, H);
  o.strokeStyle = o.fillStyle = "#fff";
  o.lineCap = o.lineJoin = "round";
  for (const s of masks) strokePath(o, s);
  return { sketch: c.toDataURL("image/png"), mask: off.toDataURL("image/png") };
}

/** Send one asset's mark-up (plus an optional shared note). Returns the feedback folder name. */
async function sendAsset(a: AssetRow, m: Markup, extraNote = ""): Promise<string> {
  const pins = pinsOf(m);
  if (pins.some((p) => !p.text.trim())) throw new Error("every pin needs a text");
  const notes = [m.notes.trim(), extraNote.trim()].filter(Boolean).join("\n");
  if (!pins.length && !notes) throw new Error("add a pin or a note first");
  if (!a.meta) throw new Error("the asset file is missing");
  const { sketch, mask } = await exportFor(a, m);
  const r = await api<{ folder: string; agent: string }>("/send", {
    asset: a.id,
    pins: pins.map((p) => ({ x: p.x, y: p.y, text: p.text })),
    notes,
    sketch,
    mask,
    photos: m.photos,
  });
  if (markups.has(a.id)) {
    m.sent = true;
    saveDraft(a.id);
  }
  return r.folder;
}

async function send() {
  const a = sel();
  if (!a) return;
  viewVersion = null;
  ($("send") as HTMLButtonElement).disabled = true;
  try {
    const folder = await sendAsset(a, markup());
    toast(`Sent (${folder})`);
    lastReplyKey = "";
    await refreshProject();
    pollFeedback();
  } catch (e) {
    toast(`Send failed: ${(e as Error).message}`);
  } finally {
    ($("send") as HTMLButtonElement).disabled = false;
  }
}

// ------------------------------------------------------------------ wiring

document.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  // ---- tags
  if (t.dataset.list) {
    listMode = t.dataset.list as typeof listMode;
    try {
      localStorage.setItem("asset-studio.listMode", listMode);
    } catch {
      /* storage blocked */
    }
    return renderList();
  }
  if (t.dataset.untag && selId) return tagOp({ op: "assets", id: t.dataset.untag, remove: [selId] }, "Removed from tag");
  if (t.id === "bTagRemove" && boardGroup) {
    const ids = pickedRows().map((a) => a.id);
    await tagOp({ op: "assets", id: boardGroup, remove: ids }, `${ids.length} removed from "${tagById(boardGroup)?.label}"`);
    ids.forEach((id) => picked.delete(id));
    return renderBoard();
  }
  if (t.id === "bTagRename" && boardGroup) {
    const label = prompt("New name for the tag:", tagById(boardGroup)?.label ?? "")?.trim();
    if (label) await tagOp({ op: "rename", id: boardGroup, label }, "Tag renamed");
    return;
  }
  if (t.id === "bTagDelete" && boardGroup) {
    const tag = tagById(boardGroup);
    if (tag && confirm(`Delete the tag "${tag.label}"? Its ${tag.assets.length} image(s) stay where they are.`)) {
      boardGroup = "";
      await tagOp({ op: "delete", id: tag.id }, `Tag "${tag.label}" deleted`);
    }
    return;
  }
  // ---- board
  if (t.dataset.pick) return pick(t.dataset.pick, (t as HTMLInputElement).checked, e.shiftKey);
  const filterBtn = t.closest<HTMLElement>("[data-filter]");
  if (filterBtn) {
    boardFilter = filterBtn.dataset.filter!;
    return renderBoard();
  }
  if (t.id === "bAll") {
    boardShown().forEach((a) => picked.add(a.id));
    return renderBoard();
  }
  if (t.id === "bNone") {
    picked.clear();
    return renderBoard();
  }
  if (t.id === "bApprove") return runBatch("approve");
  if (t.id === "bNeedsFix") return runBatch("needs_fix");
  if (t.id === "bAccept") return runBatch("accept");
  if (t.id === "bReject") return runBatch("reject");
  if (t.id === "bSendMarked") return sendMany(boardPool().filter((a) => isMarked(a.id)), "", "their own mark-up");
  if (t.id === "bSendNote") {
    const note = ($("bNote") as HTMLInputElement).value.trim();
    const rows = pickedRows();
    const bare = rows.filter((a) => !isMarked(a.id));
    if (!note && bare.length) return toast(`Write a note first: ${bare.length} selected asset(s) have no mark-up of their own`);
    await sendMany(rows, note, note ? `note: "${note}"` : "their own mark-up");
    if (!$("bProgress").textContent?.includes("Not sent")) ($("bNote") as HTMLInputElement).value = "";
    return;
  }
  // ---- list, focus, panel
  const row = t.closest<HTMLElement>("[data-id]");
  if (row && (row.classList.contains("asset") || row.classList.contains("card"))) return select(row.dataset.id!, !row.classList.contains("card"));
  if (t.dataset.view && t.closest("#views")) return setView(t.dataset.view as typeof view);
  if (t.dataset.tool) {
    tool = t.dataset.tool as Tool;
    document.querySelectorAll<HTMLButtonElement>("#toolbar [data-tool]").forEach((b) => b.classList.toggle("on", b === t));
    return;
  }
  if (t.dataset.photo) {
    markup().photos.splice(Number(t.dataset.photo), 1);
    touch();
    return renderPanel();
  }
  if (t.dataset.viewV) {
    viewVersion = Number(t.dataset.viewV);
    toast(`Viewing v${viewVersion}`);
    return setView("focus");
  }
  const a = sel();
  if (!a) return;
  try {
    if (t.dataset.revert) {
      await api("/revert", { asset: a.id, v: Number(t.dataset.revert) });
      viewVersion = null;
      toast(`v${t.dataset.revert} is current again`);
      return refreshProject();
    }
    if (t.id === "accept") {
      await api("/accept", { asset: a.id });
      compare = false;
      ($("compare") as HTMLInputElement).checked = false;
      forget(a.id);
      toast("Accepted: the game file is updated");
      return refreshProject().then(render);
    }
    if (t.id === "reject") {
      await api("/reject", { asset: a.id });
      compare = false;
      ($("compare") as HTMLInputElement).checked = false;
      toast("Rejected: edit the mark-up and Send again");
      return refreshProject().then(render);
    }
    if (t.id === "approve") return api("/status", { asset: a.id, status: "approved" }).then(refreshProject);
    if (t.id === "needsFix") return api("/status", { asset: a.id, status: "needs_fix" }).then(refreshProject);
  } catch (err) {
    toast((err as Error).message);
  }
});

$("send").addEventListener("click", send);
$("board").addEventListener("dblclick", (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>(".card");
  if (!card || (e.target as HTMLElement).dataset.pick) return;
  select(card.dataset.id!);
  setView("focus");
});
$("boardGroup").addEventListener("change", (e) => {
  boardGroup = (e.target as HTMLSelectElement).value;
  renderBoard();
});
/** "Add to tag" selects (Board: the selection; panel: the asset shown). "__new" makes a tag first. */
async function addToTag(sel: HTMLSelectElement, ids: string[]) {
  const v = sel.value;
  sel.value = "";
  if (!v || !ids.length) return;
  if (v === "__new") return void (await newTag(ids));
  await tagOp({ op: "assets", id: v, add: ids }, `${ids.length} added to "${tagById(v)?.label}"`);
}
$("bTagAdd").addEventListener("change", (e) => addToTag(e.target as HTMLSelectElement, pickedRows().map((a) => a.id)));
$("assetTags").addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.id === "panelTagAdd" && selId) addToTag(t, [selId]);
});
$("undo").addEventListener("click", () => {
  markup().items.pop();
  touch();
  renderPanel();
  render();
});
$("clear").addEventListener("click", () => {
  markup().items = [];
  touch();
  renderPanel();
  render();
});
$("compare").addEventListener("change", (e) => {
  compare = (e.target as HTMLInputElement).checked;
  if (compare && !sel()?.meta?.candidate) {
    compare = false;
    (e.target as HTMLInputElement).checked = false;
    toast("No candidate to compare yet");
  }
  render();
});
$("zoom").addEventListener("change", fitStage);
$("pins").addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  pinsOf(markup())[Number(t.dataset.pin)].text = t.value;
  touch();
});
$("notes").addEventListener("input", (e) => {
  markup().notes = (e.target as HTMLTextAreaElement).value;
  touch();
});
lineup.addEventListener("click", (e) => {
  const gr = groupOfSel() ?? project?.groups[0];
  if (!gr) return;
  const r = lineup.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * lineup.width;
  const i = Math.round(x / (lineup.width / (gr.assets.length + 1))) - 1;
  const a = gr.assets[Math.max(0, Math.min(gr.assets.length - 1, i))];
  if (a) {
    selId = a.id;
    renderList();
    renderPanel();
    renderLineup();
  }
});

function addPhoto(file: File) {
  if (!file.type.startsWith("image/")) return toast("Only images");
  if (file.size > 5 * 1024 * 1024) return toast("Max 5 MB per photo");
  const m = markup();
  if (m.photos.length >= 6) return toast("Max 6 photos");
  const fr = new FileReader();
  fr.onload = () => {
    m.photos.push(String(fr.result));
    touch();
    renderPanel();
  };
  fr.readAsDataURL(file);
}
document.addEventListener("paste", (e) => {
  for (const it of e.clipboardData?.items ?? []) if (it.kind === "file") addPhoto(it.getAsFile()!);
});
$("photos").addEventListener("dragover", (e) => e.preventDefault());
$("photos").addEventListener("drop", (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer?.files ?? []) addPhoto(f);
});
document.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).matches("input, textarea")) return;
  if (e.ctrlKey && e.key === "z") return $("undo").click();
  const k = { m: "mask", p: "pin", d: "pen", a: "arrow" }[e.key.toLowerCase()];
  if (k) (document.querySelector(`[data-tool="${k}"]`) as HTMLElement).click();
});
window.addEventListener("resize", () => view === "focus" && fitStage());

api<Record<string, Markup>>("/drafts")
  .then((d) => Object.entries(d).forEach(([id, m]) => markups.set(id, m)))
  .catch(() => toast("Could not load saved drafts"))
  .then(refreshProject)
  .then(() => {
    const first = allAssets()[0];
    if (first) select(first.id);
  });
setInterval(pollFeedback, 2000);
setInterval(() => refreshProject().catch(() => {}), 6000);
