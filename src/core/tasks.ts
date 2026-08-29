import type { DatabaseSync } from "node:sqlite";
import type { Phase, Task, TaskEvent, WorkItem } from "./types.ts";
import { phaseForStatus } from "./lifecycle.ts";

/**
 * Local projection of the tasks the datasource surfaces to this operator.
 *
 * The datasource is authoritative for lifecycle state (its `faktory_status`)
 * and ownership; this table is a *cache* of that state joined with local-only
 * execution coordinates (herdr ids, branch, PR url, error) that mean nothing to
 * other operators. It never originates a phase: `phase` is only ever written
 * from a value the datasource reported (`upsertFromItem`) or from a transition
 * the engine already committed to the datasource (`record`). Delete this DB and
 * a `sync` rebuilds every phase from the source.
 */

function rowToTask(r: Record<string, unknown>): Task {
  return {
    id: r.id as number,
    sourceId: r.source_id as string,
    itemId: r.item_id as string,
    title: r.title as string,
    url: r.url as string,
    phase: r.phase as Phase,
    priority: r.priority as number | null,
    workspaceId: r.workspace_id as string | null,
    paneId: r.pane_id as string | null,
    agentName: r.agent_name as string | null,
    branch: r.branch as string | null,
    prUrl: r.pr_url as string | null,
    error: r.error as string | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export class TaskStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Insert-or-reconcile a task from a datasource item. The cached phase is
   * always taken *from* the source (`faktory_status`), so this is the point
   * where the projection catches up to the authoritative state — a phase that
   * changed out of band (another tool, another operator, or a rebuilt DB) is
   * reconciled here and audited as a `source` event.
   */
  upsertFromItem(sourceId: string, item: WorkItem): Task {
    const phase = phaseForStatus(item.status);
    const existing = this.bySourceItem(sourceId, item.id);
    if (existing) {
      this.db
        .prepare(
          "UPDATE tasks SET title = ?, url = ?, priority = ?, phase = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
        )
        .run(item.title, item.url, item.priority, phase, existing.id);
      if (existing.phase !== phase)
        this.logEvent(existing.id, existing.phase, phase, "source", "reconciled from datasource");
      return this.byId(existing.id)!;
    }
    const res = this.db
      .prepare(
        "INSERT INTO tasks (source_id, item_id, title, url, phase, priority) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(sourceId, item.id, item.title, item.url, phase, item.priority);
    const task = this.byId(Number(res.lastInsertRowid))!;
    this.logEvent(
      task.id,
      null,
      phase,
      "source",
      phase === "discovered" ? "discovered in source" : "reconciled from datasource",
    );
    return task;
  }

  byId(id: number): Task | null {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToTask(r) : null;
  }

  bySourceItem(sourceId: string, itemId: string): Task | null {
    const r = this.db
      .prepare("SELECT * FROM tasks WHERE source_id = ? AND item_id = ?")
      .get(sourceId, itemId) as Record<string, unknown> | undefined;
    return r ? rowToTask(r) : null;
  }

  list(phase?: Phase): Task[] {
    const rows = (
      phase
        ? this.db
            .prepare("SELECT * FROM tasks WHERE phase = ? ORDER BY priority DESC, id")
            .all(phase)
        : this.db.prepare("SELECT * FROM tasks ORDER BY id").all()
    ) as Record<string, unknown>[];
    return rows.map(rowToTask);
  }

  /**
   * Record a phase the engine has already committed to the datasource, together
   * with any local execution coordinates. This is a *projection write*: it does
   * not validate the lifecycle (the engine does that against the authoritative
   * source status before calling here) — it just mirrors the committed state and
   * appends an audit event.
   */
  record(
    id: number,
    to: Phase,
    actor: string,
    opts: { note?: string; force?: boolean; patch?: Partial<TaskPatch> } = {},
  ): Task {
    const task = this.byId(id);
    if (!task) throw new Error(`task ${id} not found`);
    const patch = opts.patch ?? {};
    this.db
      .prepare(
        `UPDATE tasks SET phase = ?,
           workspace_id = COALESCE(?, workspace_id),
           pane_id      = COALESCE(?, pane_id),
           agent_name   = COALESCE(?, agent_name),
           branch       = COALESCE(?, branch),
           pr_url       = COALESCE(?, pr_url),
           error        = ?,
           updated_at   = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      )
      .run(
        to,
        patch.workspaceId ?? null,
        patch.paneId ?? null,
        patch.agentName ?? null,
        patch.branch ?? null,
        patch.prUrl ?? null,
        patch.error ?? null,
        id,
      );
    this.logEvent(id, task.phase, to, actor, opts.note ?? null, opts.force ?? false);
    return this.byId(id)!;
  }

  events(taskId: number): TaskEvent[] {
    const rows = this.db
      .prepare('SELECT id, task_id, at, "from", "to", actor, note FROM task_events WHERE task_id = ? ORDER BY id')
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      taskId: r.task_id as number,
      at: r.at as string,
      from: (r.from as Phase | null) ?? null,
      to: r.to as Phase,
      actor: r.actor as string,
      note: r.note as string | null,
    }));
  }

  private logEvent(
    taskId: number,
    from: Phase | null,
    to: Phase,
    actor: string,
    note: string | null,
    forced = false,
  ): void {
    this.db
      .prepare('INSERT INTO task_events (task_id, "from", "to", actor, note) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, from, to, actor, forced ? `[forced] ${note ?? ""}`.trim() : note);
  }
}

export interface TaskPatch {
  workspaceId: string;
  paneId: string;
  agentName: string;
  branch: string;
  prUrl: string;
  error: string;
}
