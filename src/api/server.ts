import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine } from "../core/engine.ts";
import type { Phase } from "../core/types.ts";
import { PHASES } from "../core/types.ts";
import type { HerdrClient } from "../herdr/client.ts";
import { dispatchTask, type DispatchOptions } from "../herdr/orchestrator.ts";

/**
 * HTTP control plane. Consumed by the web UI and by the orchestrator agent
 * (via the faktory-orchestrator skill). JSON in/out, localhost only.
 */
export interface ApiDeps {
  engine: Engine;
  prefix: string;
  herdr?: HerdrClient;
  dispatchDefaults?: Partial<DispatchOptions>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

export function createApiServer(deps: ApiDeps): Server {
  const routes: Array<{ method: string; pattern: RegExp; names: string[]; handler: Handler }> = [];

  const route = (method: string, path: string, handler: Handler) => {
    const names: string[] = [];
    const pattern = new RegExp(
      "^" + path.replace(/:([a-zA-Z]+)/g, (_, n) => (names.push(n), "([^/]+)")) + "$",
    );
    routes.push({ method, pattern, names, handler });
  };

  route("GET", "/api/health", async (_req, res) => {
    json(res, 200, { ok: true, prefix: deps.prefix, phases: PHASES });
  });

  route("GET", "/api/tasks", async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const phase = url.searchParams.get("phase") as Phase | null;
    json(res, 200, { tasks: deps.engine.tasks.list(phase ?? undefined) });
  });

  route("GET", "/api/tasks/:id", async (_req, res, p) => {
    const task = deps.engine.tasks.byId(Number(p.id));
    if (!task) return json(res, 404, { error: "not found" });
    json(res, 200, { task, events: deps.engine.tasks.events(task.id) });
  });

  route("POST", "/api/sync", async (_req, res) => {
    const fresh = await deps.engine.syncCandidates();
    json(res, 200, { discovered: fresh });
  });

  route("POST", "/api/tasks/:id/transition", async (req, res, p) => {
    const body = await readJson(req);
    const to = body.to as Phase;
    if (!PHASES.includes(to)) return json(res, 400, { error: `invalid phase ${JSON.stringify(body.to)}` });
    try {
      const task = await deps.engine.transition(Number(p.id), to, String(body.actor ?? "api"), body.note);
      json(res, 200, { task });
    } catch (e) {
      json(res, 409, { error: String((e as Error).message) });
    }
  });

  route("POST", "/api/tasks/:id/dispatch", async (req, res, p) => {
    if (!deps.herdr) return json(res, 503, { error: "herdr is not connected" });
    const body = await readJson(req);
    const id = Number(p.id);
    const task = deps.engine.tasks.byId(id);
    if (!task) return json(res, 404, { error: "not found" });
    try {
      await deps.engine.transition(id, "dispatching", "api", "dispatch requested");
      const opts: DispatchOptions = {
        agentKind: body.agentKind ?? deps.dispatchDefaults?.agentKind ?? "pi",
        repoCwd: body.repoCwd ?? deps.dispatchDefaults?.repoCwd,
        repoWorkspaceId: body.repoWorkspaceId ?? deps.dispatchDefaults?.repoWorkspaceId,
        kickoffCommand: body.kickoffCommand ?? deps.dispatchDefaults?.kickoffCommand,
      };
      const result = await dispatchTask(deps.herdr, task, deps.prefix, opts);
      const updated = deps.engine.tasks.transition(id, "running", "api", { note: "agent started", patch: result });
      json(res, 200, { task: updated, herdr: result });
    } catch (e) {
      const failed = deps.engine.tasks.transition(id, "failed", "api", {
        note: String((e as Error).message),
        force: true,
        patch: { error: String((e as Error).message) },
      });
      json(res, 500, { error: String((e as Error).message), task: failed });
    }
  });

  const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(path);
        if (!m) continue;
        const params = Object.fromEntries(r.names.map((n, i) => [n, m[i + 1]!]));
        await r.handler(req, res, params);
        return;
      }
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(join(webDir, "index.html")));
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: String((e as Error).message) });
    }
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
