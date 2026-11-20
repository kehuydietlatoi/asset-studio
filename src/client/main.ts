/** Asset Studio page: pick an asset, mark it up, Send, then compare and accept the agent's candidate. */

type Version = { n: number; at: string; source: string; parent?: number; prompt?: string; agent?: string };
type Meta = { id: string; status: string; current: number; candidate: number | null; versions: Version[] };
type AssetRow = { id: string; label: string; scale: number; meta: Meta | null; job: string | null };
type Group = { id: string; label: string; assets: AssetRow[] };
type Project = { name: string; agent: string; stage: { sky?: string; ground?: string; groundY?: number }; groups: Group[] };
type ReplyNote = { pin: number | null; status: "fixed" | "question" | "wont"; text: string };
type Feedback = { folder: string; ack: { by: string } | null; reply: { summary: string; notes: ReplyNote[]; candidate?: number } | null; job: string | null };

type Pt = [number, number];
type Item =
  | { kind: "mask" | "pen"; w: number; pts: Pt[] }
  | { kind: "arrow"; a: Pt; b: Pt }
  | { kind: "pin"; x: number; y: number; text: string };
type Markup = { items: Item[]; notes: string; photos: string[] };
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
const sel = () => allAssets().find((a) => a.id === selId) ?? null;
const groupOfSel = () => project?.groups.find((gr) => gr.assets.some((a) => a.id === selId)) ?? null;
function markup(): Markup {
  if (!selId) return { items: [], notes: "", photos: [] };
  let m = markups.get(selId);
  if (!m) markups.set(selId, (m = { items: [], notes: "", photos: [] }));
  return m;
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
  if (a.job) return `<span class="chip job">${a.job}</span>`;
  const s = a.meta?.status ?? "generated";
  const cand = a.meta?.candidate ? ` · v${a.meta.candidate} ready` : "";
  return `<span class="chip ${s}">${STATUS_LABEL[s] ?? s}${cand}</span>`;
}

function renderList() {
  if (!project) return;
  $("assetList").innerHTML = project.groups
    .map(
      (gr) =>
        `<div class="group"><h3>${gr.label} (${gr.assets.length})</h3>` +
        gr.assets
          .map(
            (a) =>
              `<div class="asset ${a.id === selId ? "sel" : ""}" data-id="${a.id}"><img src="${a.meta ? imgUrl(a.id, a.meta.current) : ""}" alt="" /><span class="lbl">${a.label}</span>${chip(a)}</div>`,
          )
          .join("") +
        `</div>`,
    )
    .join("");
  if (view === "board") renderBoard();
}

function renderBoard() {
  const gr = groupOfSel() ?? project?.groups[0];
  if (!gr) return;
  $("board").innerHTML = gr.assets
    .map(
      (a) =>
        `<div class="card" data-id="${a.id}"><img src="${a.meta ? imgUrl(a.id, a.meta.candidate ?? a.meta.current) : ""}" alt="" /><div>${a.label}</div><div class="meta">${chip(a)}<span>${a.meta?.versions.length ?? 0} v</span></div></div>`,
    )
    .join("");
}

function select(id: string) {
  selId = id;
  viewVersion = null;
  compare = false;
  ($("compare") as HTMLInputElement).checked = false;
  lastFeedback = null;
  renderList();
  renderPanel();
  pollFeedback();
  setView("focus");
}

// ------------------------------------------------------------------ panel

function renderPanel() {
  const a = sel();
  $("assetTitle").textContent = a ? a.label : "Pick an asset";
  const m = markup();
  const s = a?.meta?.status ?? "";
  $("statusChip").className = `chip ${s}`;
  $("statusChip").textContent = a ? STATUS_LABEL[s] ?? s : "";
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

function drawMarkup(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const m = markup();
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
stage.addEventListener("pointerup", () => (drawing = null));

// ------------------------------------------------------------------ send

function exportSketch(): string {
  const prev = compare;
  compare = false;
  renderFocus();
  const url = stage.toDataURL("image/png");
  compare = prev;
  renderFocus();
  return url;
}

function exportMask(): string | null {
  const masks = markup().items.filter((i) => i.kind === "mask");
  if (!masks.length) return null;
  const off = document.createElement("canvas");
  off.width = stage.width;
  off.height = stage.height;
  const o = off.getContext("2d")!;
  o.fillStyle = "#000";
  o.fillRect(0, 0, off.width, off.height);
  o.strokeStyle = o.fillStyle = "#fff";
  o.lineCap = o.lineJoin = "round";
  for (const s of masks) strokePath(o, s as Extract<Item, { kind: "mask" }>);
  return off.toDataURL("image/png");
}

async function send() {
  const a = sel();
  if (!a) return;
  const m = markup();
  const pins = m.items.filter((i): i is Extract<Item, { kind: "pin" }> => i.kind === "pin");
  if (pins.some((p) => !p.text.trim())) return toast("Every pin needs a text");
  if (!pins.length && !m.notes.trim()) return toast("Add a pin or a note first");
  viewVersion = null;
  ($("send") as HTMLButtonElement).disabled = true;
  try {
    const r = await api<{ folder: string; agent: string }>("/send", {
      asset: a.id,
      pins: pins.map((p) => ({ x: p.x, y: p.y, text: p.text })),
      notes: m.notes,
      sketch: exportSketch(),
      mask: exportMask(),
      photos: m.photos,
    });
    toast(`Sent (${r.folder})`);
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
  const row = t.closest<HTMLElement>("[data-id]");
  if (row && (row.classList.contains("asset") || row.classList.contains("card"))) return select(row.dataset.id!);
  if (t.dataset.view && t.closest("#views")) return setView(t.dataset.view as typeof view);
  if (t.dataset.tool) {
    tool = t.dataset.tool as Tool;
    document.querySelectorAll<HTMLButtonElement>("#toolbar [data-tool]").forEach((b) => b.classList.toggle("on", b === t));
    return;
  }
  if (t.dataset.photo) {
    markup().photos.splice(Number(t.dataset.photo), 1);
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
      markups.delete(a.id);
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
$("undo").addEventListener("click", () => {
  markup().items.pop();
  renderPanel();
  render();
});
$("clear").addEventListener("click", () => {
  markup().items = [];
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
  const pins = markup().items.filter((i): i is Extract<Item, { kind: "pin" }> => i.kind === "pin");
  pins[Number(t.dataset.pin)].text = t.value;
});
$("notes").addEventListener("input", (e) => (markup().notes = (e.target as HTMLTextAreaElement).value));
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

refreshProject().then(() => {
  const first = allAssets()[0];
  if (first) select(first.id);
});
setInterval(pollFeedback, 2000);
setInterval(() => refreshProject().catch(() => {}), 6000);
