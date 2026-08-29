import type { DatabaseSync } from "node:sqlite";
import type { Phase, Task, TaskEvent, WorkItem } from "./types.ts";
import { canTransition } from "./lifecycle.ts";

/** Task repository + the single legal way to change a task's phase. */

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

  /** Insert-or-refresh a task from a source candidate. New tasks start `discovered`. */
  upsertFromItem(sourceId: string, item: WorkItem): Task {
    const existing = this.bySourceItem(sourceId, item.id);
    if (existing) {
      this.db
        .prepare(
          "UPDATE tasks SET title = ?, url = ?, priority = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
        )
        .run(item.title, item.url, item.priority, existing.id);
      if (item.dependsOn) this.setDependencies(existing.id, item.dependsOn);
      return this.byId(existing.id)!;
    }
    const res = this.db
      .prepare(
        "INSERT INTO tasks (source_id, item_id, title, url, phase, priority) VALUES (?, ?, ?, ?, 'discovered', ?)",
      )
      .run(sourceId, item.id, item.title, item.url, item.priority);
    const task = this.byId(Number(res.lastInsertRowid))!;
    if (item.dependsOn) this.setDependencies(task.id, item.dependsOn);
    this.logEvent(task.id, null, "discovered", "engine", "discovered in source");
    return task;
  }

  /**
   * Replace a task's dependency set with the source's current truth. Stored by
   * the dependency's source item id; self-references are dropped defensively.
   */
  setDependencies(taskId: number, dependsOnItemIds: string[]): void {
    const self = this.byId(taskId);
    this.db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(taskId);
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_item_id) VALUES (?, ?)",
    );
    for (const dep of dependsOnItemIds) {
      if (dep && dep !== self?.itemId) ins.run(taskId, dep);
    }
  }

  /** Source item ids this task depends on. */
  dependencyItemIds(taskId: number): string[] {
    const rows = this.db
      .prepare("SELECT depends_on_item_id AS d FROM task_dependencies WHERE task_id = ? ORDER BY d")
      .all(taskId) as { d: string }[];
    return rows.map((r) => r.d);
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
   * The only legal phase mutation. Validates against the lifecycle table,
   * stamps updated_at, and appends an audit event.
   */
  transition(
    id: number,
    to: Phase,
    actor: string,
    opts: { note?: string; force?: boolean; patch?: Partial<TaskPatch> } = {},
  ): Task {
    const task = this.byId(id);
    if (!task) throw new Error(`task ${id} not found`);
    if (!opts.force && !canTransition(task.phase, to)) {
      throw new Error(`illegal transition ${task.phase} → ${to} for task ${id}`);
    }
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
