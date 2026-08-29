import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Engine } from "../core/engine.ts";
import type { Phase, Role } from "../core/types.ts";
import { PHASES, STAGES } from "../core/types.ts";
import { isInboxType } from "../core/inbox.ts";

/**
 * HTTP control plane. It is now a thin, read-mostly surface: the board/feed for
 * viewers, and the **inbox** endpoint agents use to talk back to the loop
 * (`faktory report` wraps it). Dispatch and lifecycle policy live in the engine
 * loop, not here — the only writes callers make are inbox messages and manual
 * repair transitions. JSON in/out, localhost only.
 */
export interface ApiDeps {
  engine: Engine;
  prefix: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

export function createApiServer(deps: ApiDeps): Server {
  const routes: Array<{ method: string; pattern: RegExp; names: string[]; handler: Handler }> = [];

  const route = (method: string, path: string, handler: Handler) => {
    const names: string[] = [];
    const pattern = new RegExp("^" + path.replace(/:([a-zA-Z]+)/g, (_, n) => (names.push(n), "([^/]+)")) + "$");
    routes.push({ method, pattern, names, handler });
  };

  route("GET", "/api/health", async (_req, res) => {
    json(res, 200, { ok: true, prefix: deps.prefix, phases: PHASES, stages: STAGES });
  });

  route("GET", "/api/tasks", async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const phase = url.searchParams.get("phase") as Phase | null;
    json(res, 200, { tasks: deps.engine.tasks.list(phase ?? undefined) });
  });

  route("GET", "/api/tasks/:id", async (_req, res, p) => {
    const task = deps.engine.tasks.byId(Number(p.id));
    if (!task) return json(res, 404, { error: "not found" });
    json(res, 200, {
      task,
      events: deps.engine.tasks.events(task.id),
      inbox: deps.engine.inbox.forTask(task.id),
      stages: deps.engine.tasks.stagesFor(task.id),
    });
  });

  // The board grouped by column (phase), each ordered by priority desc.
  route("GET", "/api/board", async (_req, res) => {
    const columns = PHASES.map((phase) => ({ phase, tasks: deps.engine.tasks.list(phase) }));
    json(res, 200, { columns });
  });

  route("GET", "/api/feed", async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const limit = Number(url.searchParams.get("limit") ?? 50);
    json(res, 200, { feed: deps.engine.feed.recent(Number.isFinite(limit) ? limit : 50) });
  });

  route("POST", "/api/sync", async (_req, res) => {
    const fresh = await deps.engine.syncCandidates();
    json(res, 200, { discovered: fresh });
  });

  // Manual repair only — the loop owns automatic transitions. `force` bypasses
  // lifecycle validation (still audited) for stuck-state repair.
  route("POST", "/api/tasks/:id/transition", async (req, res, p) => {
    const body = await readJson(req);
    const to = body.to as Phase;
    if (!PHASES.includes(to)) return json(res, 400, { error: `invalid phase ${JSON.stringify(body.to)}` });
    try {
      const task = body.force
        ? deps.engine.tasks.transition(Number(p.id), to, String(body.actor ?? "api"), {
            force: true,
            note: body.note,
          })
        : await deps.engine.transition(Number(p.id), to, String(body.actor ?? "api"), body.note);
      json(res, 200, { task });
    } catch (e) {
      json(res, 409, { error: String((e as Error).message) });
    }
  });

  route("POST", "/api/tasks/:id/comment", async (req, res, p) => {
    const body = await readJson(req);
    const id = Number(p.id);
    if (!deps.engine.tasks.byId(id)) return json(res, 404, { error: "not found" });
    if (body.note == null && body.from == null && body.to == null && body.data == null) {
      return json(res, 400, { error: "comment requires at least one of note, from, to, data" });
    }
    try {
      const rendered = await deps.engine.comment(id, {
        from: body.from,
        to: body.to,
        note: body.note,
        data: body.data,
      });
      json(res, 200, { ok: true, body: rendered });
    } catch (e) {
      json(res, 500, { error: String((e as Error).message) });
    }
  });

  // The inbox: the one channel agents use to talk back to the loop. The loop
  // (not this endpoint) validates origin + transition legality and applies it.
  route("POST", "/api/tasks/:id/inbox", async (req, res, p) => {
    const body = await readJson(req);
    const id = Number(p.id);
    if (!deps.engine.tasks.byId(id)) return json(res, 404, { error: "not found" });
    if (!isInboxType(body.type)) {
      return json(res, 400, { error: `type must be one of handoff | note` });
    }
    const stage = body.stage as Role | undefined;
    if (stage != null && stage !== "unblock" && !(STAGES as readonly string[]).includes(stage)) {
      return json(res, 400, { error: `invalid stage ${JSON.stringify(body.stage)}` });
    }
    const message = deps.engine.inbox.enqueue({
      taskId: id,
      type: body.type,
      stage: stage ?? null,
      sender: body.sender ?? null,
      note: body.note ?? null,
      data: body.data ?? null,
    });
    json(res, 202, { ok: true, message });
  });

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
