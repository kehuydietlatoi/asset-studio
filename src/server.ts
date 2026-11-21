/** The studio page + its local API, served by Vite. Binds to 127.0.0.1 only. */
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";
import type { LoadedConfig } from "./config.ts";
import { fixFeedback } from "./fixer.ts";
import { createLogger, tailLog, type Logger } from "./log.ts";
import {
  allJobs,
  getMeta,
  isInterrupted,
  jobLabel,
  latestFeedback,
  makeCurrent,
  pendingFeedback,
  readJob,
  rejectCandidate,
  setStatus,
  StoreError,
  versionPath,
  writeFeedback,
  writeJob,
  writeReply,
  type ReviewStatus,
  type SendPayload,
} from "./store.ts";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "client");
const MAX_BODY = 60 * 1024 * 1024;
const STATUSES: ReviewStatus[] = ["generated", "in_review", "needs_fix", "approved"];

/**
 * Codex mode: Sends are fixed one at a time, in order. A job that hangs is killed by the fixer's timeout
 * (`fixTimeoutMin`), so one bad Codex run can no longer block every Send behind it.
 */
export class FixQueue {
  private chain: Promise<void> = Promise.resolve();
  private waiting: string[] = [];
  current: string | null = null;
  constructor(
    private cfg: LoadedConfig,
    private L: Logger,
  ) {}
  /** 1-based place among the waiting jobs (0 = running now, -1 = not in this queue). */
  position(folder: string): number {
    if (this.current === folder) return 0;
    const i = this.waiting.indexOf(folder);
    return i < 0 ? -1 : i + 1;
  }
  push(folder: string, asset: string): void {
    if (this.position(folder) >= 0) return;
    this.waiting.push(folder);
    writeJob(folder, { state: "queued", stage: "", agent: "codex", owner: process.pid, queuedAt: new Date().toISOString() });
    this.L.scope(asset).info(`${basename(folder)}: queued (${this.waiting.length} waiting${this.current ? `, running ${basename(this.current)}` : ""})`);
    this.chain = this.chain.then(async () => {
      this.waiting.shift();
      this.current = folder;
      try {
        await fixFeedback(this.cfg, folder, { agent: "codex", logger: this.L });
      } catch (e) {
        // fixFeedback already logged it and marked job.json failed; answer the Send so the page stops waiting.
        const msg = e instanceof Error ? e.message : String(e);
        writeReply(folder, { summary: `Fix failed: ${msg.slice(0, 300)}`, notes: [{ pin: null, status: "wont", text: msg.slice(0, 300) }] });
      } finally {
        this.current = null;
      }
    });
  }
}

function api(cfg: LoadedConfig, L: Logger): Plugin {
  const queue = new FixQueue(cfg, L);
  for (const f of pendingFeedback(cfg)) {
    const asset = JSON.parse(readFileSync(join(f, "notes.json"), "utf8")).asset as string;
    const j = readJob(f);
    if (j && isInterrupted(j)) L.scope(asset).warn(`${basename(f)}: was "${j.state}: ${j.stage}" when its studio process stopped`);
    if (cfg.agent === "codex") queue.push(f, asset);
  }

  /** Page text for an unanswered Send: stage, elapsed time and place in the queue. */
  const jobText = (folder: string): string | null => {
    const pos = queue.position(folder);
    const label = jobLabel(readJob(folder));
    return pos > 0 && label ? `${label} · #${pos} in queue` : label;
  };

  const project = () => ({
    name: cfg.name,
    agent: cfg.agent,
    stage: cfg.stage ?? {},
    groups: cfg.groups.map((g) => ({
      id: g.id,
      label: g.label,
      assets: g.assets.map((a) => {
        let meta = null;
        try {
          meta = getMeta(cfg, a.id);
        } catch (e) {
          if (!(e instanceof StoreError)) throw e;
        }
        const f = latestFeedback(cfg, a.id);
        return { id: a.id, label: a.label, scale: a.scale ?? 1, meta, job: f && !f.reply ? jobText(f.folder) : null };
      }),
    })),
  });

  return {
    name: "asset-studio-api",
    configureServer(server) {
      server.middlewares.use("/api", (req: IncomingMessage, res: ServerResponse) => {
        const json = (code: number, body: unknown) => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(body));
        };
        const host = (req.headers.host ?? "").split(":")[0];
        if (host !== "localhost" && host !== "127.0.0.1") return json(403, { error: "local only" });
        const url = new URL(req.url ?? "/", "http://localhost");
        const asset = url.searchParams.get("asset") ?? "";
        const known = cfg.byId.has(asset);

        const fail = (e: unknown) => {
          const msg = e instanceof Error ? e.message : "error";
          if (e instanceof StoreError) L.warn(`${req.method} ${url.pathname}: ${msg}`);
          else L.error(`${req.method} ${url.pathname} crashed: ${e instanceof Error ? (e.stack ?? msg) : msg}`);
          json(e instanceof StoreError ? 400 : 500, { error: msg });
        };
        const body = (fn: (b: any) => unknown) => {
          const chunks: Buffer[] = [];
          let size = 0;
          req.on("data", (c: Buffer) => {
            size += c.length;
            if (size <= MAX_BODY) chunks.push(c);
          });
          req.on("end", () => {
            if (size > MAX_BODY) return json(413, { error: "request too large" });
            try {
              json(200, fn(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")) ?? { ok: true });
            } catch (e) {
              fail(e);
            }
          });
        };
        const need = (b: any) => {
          if (!cfg.byId.has(b?.asset)) throw new StoreError("unknown asset");
          return b.asset as string;
        };

        try {
          if (req.method === "GET" && url.pathname === "/project") return json(200, project());
          if (req.method === "GET" && url.pathname === "/image") {
            if (!known) return json(404, { error: "unknown asset" });
            const meta = getMeta(cfg, asset);
            const v = Number(url.searchParams.get("v") ?? meta.current);
            if (!meta.versions.some((x) => x.n === v)) return json(404, { error: "no such version" });
            const p = versionPath(cfg, asset, v);
            if (!existsSync(p)) return json(404, { error: "missing file" });
            res.setHeader("content-type", "image/png");
            res.setHeader("cache-control", "no-store");
            return res.end(readFileSync(p));
          }
          if (req.method === "GET" && url.pathname === "/feedback") {
            if (!known) return json(404, { error: "unknown asset" });
            const f = latestFeedback(cfg, asset);
            return json(200, f && { folder: basename(f.folder), ack: f.ack, reply: f.reply, job: f.reply ? null : jobText(f.folder) });
          }
          if (req.method === "GET" && url.pathname === "/log") {
            const n = Math.min(5000, Math.max(1, Number(url.searchParams.get("n") ?? 300) || 300));
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.setHeader("cache-control", "no-store");
            return res.end(tailLog(cfg.dataDir, n) || "(no log yet)");
          }
          if (req.method === "GET" && url.pathname === "/jobs")
            return json(
              200,
              allJobs(cfg)
                .slice(0, 50)
                .map((j) => ({ folder: basename(j.folder), asset: j.asset, answered: j.answered, job: j.job, label: jobLabel(j.job), queue: queue.position(j.folder) })),
            );
          if (req.method === "POST" && url.pathname === "/send")
            return body((b: SendPayload) => {
              const dir = writeFeedback(cfg, b);
              L.scope(b.asset).info(`${basename(dir)}: Send received (${b.pins.length} pin(s), mask ${b.mask ? "yes" : "no"}, ${b.photos.length} photo(s))`);
              if (cfg.agent === "codex") queue.push(dir, b.asset);
              return { ok: true, folder: basename(dir), agent: cfg.agent };
            });
          if (req.method === "POST" && url.pathname === "/accept")
            return body((b) => {
              const id = need(b);
              const meta = getMeta(cfg, id);
              if (meta.candidate == null) throw new StoreError("no candidate to accept");
              L.scope(id).info(`accepted v${meta.candidate} (was v${meta.current})`);
              return makeCurrent(cfg, id, meta.candidate);
            });
          if (req.method === "POST" && url.pathname === "/reject")
            return body((b) => {
              const id = need(b);
              L.scope(id).info(`rejected candidate v${getMeta(cfg, id).candidate}`);
              return rejectCandidate(cfg, id);
            });
          if (req.method === "POST" && url.pathname === "/revert")
            return body((b) => {
              const id = need(b);
              L.scope(id).info(`reverted to v${Number(b.v)}`);
              return makeCurrent(cfg, id, Number(b.v));
            });
          if (req.method === "POST" && url.pathname === "/status")
            return body((b) => {
              if (!STATUSES.includes(b.status)) throw new StoreError("bad status");
              return setStatus(cfg, need(b), b.status);
            });
          json(404, { error: "not found" });
        } catch (e) {
          fail(e);
        }
      });
    },
  };
}

export async function startServer(cfg: LoadedConfig): Promise<void> {
  const port = cfg.port ?? 5180;
  const L = createLogger(cfg.dataDir, { source: "dev" });
  process.on("uncaughtException", (e) => L.error(`uncaught: ${e.stack ?? e.message}`));
  process.on("unhandledRejection", (e) => L.error(`unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
  const server = await createServer({
    root: CLIENT,
    configFile: false,
    logLevel: "warn",
    server: { port, strictPort: true, host: "127.0.0.1" },
    plugins: [api(cfg, L)],
  });
  await server.listen();
  L.info(`Asset Studio for "${cfg.name}" on http://127.0.0.1:${port}  (agent: ${cfg.agent}, fix timeout ${cfg.fixTimeoutMin ?? 10} min, log: ${L.file})`);
}
