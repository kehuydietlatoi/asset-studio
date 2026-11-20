/** The studio page + its local API, served by Vite. Binds to 127.0.0.1 only. */
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";
import type { LoadedConfig } from "./config.ts";
import { fixFeedback } from "./fixer.ts";
import {
  getMeta,
  latestFeedback,
  makeCurrent,
  pendingFeedback,
  rejectCandidate,
  setStatus,
  StoreError,
  versionPath,
  writeFeedback,
  writeReply,
  type ReviewStatus,
  type SendPayload,
} from "./store.ts";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "client");
const MAX_BODY = 60 * 1024 * 1024;
const STATUSES: ReviewStatus[] = ["generated", "in_review", "needs_fix", "approved"];

/** Codex mode: Sends are fixed one at a time, in order. */
class FixQueue {
  private chain: Promise<void> = Promise.resolve();
  readonly running = new Map<string, string>();
  constructor(private cfg: LoadedConfig) {}
  push(folder: string, asset: string): void {
    this.running.set(asset, "queued");
    this.chain = this.chain.then(async () => {
      this.running.set(asset, "codex is editing…");
      try {
        await fixFeedback(this.cfg, folder, { agent: "codex", log: (s) => console.log(`[${asset}] ${s}`) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[${asset}] fix failed: ${msg}`);
        writeReply(folder, { summary: `Fix failed: ${msg.slice(0, 300)}`, notes: [{ pin: null, status: "wont", text: msg.slice(0, 300) }] });
      } finally {
        this.running.delete(asset);
      }
    });
  }
}

function api(cfg: LoadedConfig): Plugin {
  const queue = new FixQueue(cfg);
  if (cfg.agent === "codex") for (const f of pendingFeedback(cfg)) queue.push(f, JSON.parse(readFileSync(join(f, "notes.json"), "utf8")).asset);

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
        return { id: a.id, label: a.label, scale: a.scale ?? 1, meta, job: queue.running.get(a.id) ?? null };
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
              json(e instanceof StoreError ? 400 : 500, { error: e instanceof Error ? e.message : "error" });
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
            return json(200, f && { folder: basename(f.folder), ack: f.ack, reply: f.reply, job: queue.running.get(asset) ?? null });
          }
          if (req.method === "POST" && url.pathname === "/send")
            return body((b: SendPayload) => {
              const dir = writeFeedback(cfg, b);
              if (cfg.agent === "codex") queue.push(dir, b.asset);
              return { ok: true, folder: basename(dir), agent: cfg.agent };
            });
          if (req.method === "POST" && url.pathname === "/accept")
            return body((b) => {
              const id = need(b);
              const meta = getMeta(cfg, id);
              if (meta.candidate == null) throw new StoreError("no candidate to accept");
              return makeCurrent(cfg, id, meta.candidate);
            });
          if (req.method === "POST" && url.pathname === "/reject") return body((b) => rejectCandidate(cfg, need(b)));
          if (req.method === "POST" && url.pathname === "/revert") return body((b) => makeCurrent(cfg, need(b), Number(b.v)));
          if (req.method === "POST" && url.pathname === "/status")
            return body((b) => {
              if (!STATUSES.includes(b.status)) throw new StoreError("bad status");
              return setStatus(cfg, need(b), b.status);
            });
          json(404, { error: "not found" });
        } catch (e) {
          json(e instanceof StoreError ? 400 : 500, { error: e instanceof Error ? e.message : "error" });
        }
      });
    },
  };
}

export async function startServer(cfg: LoadedConfig): Promise<void> {
  const port = cfg.port ?? 5180;
  const server = await createServer({
    root: CLIENT,
    configFile: false,
    logLevel: "warn",
    server: { port, strictPort: true, host: "127.0.0.1" },
    plugins: [api(cfg)],
  });
  await server.listen();
  console.log(`Asset Studio for "${cfg.name}" on http://127.0.0.1:${port}  (agent: ${cfg.agent})`);
}
