import type { DatabaseSync } from "node:sqlite";
import type { Phase, Stage, Task, TaskEvent, TaskStage, WorkItem } from "./types.ts";
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
    stage: (r.stage as Stage | null) ?? null,
    dispatchedAt: (r.dispatched_at as string | null) ?? null,
    resumePhase: (r.resume_phase as Phase | null) ?? null,
    branch: r.branch as string | null,
    prUrl: r.pr_url as string | null,
    error: r.error as string | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export class TaskStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert-or-refresh a task from a source candidate. New tasks start `backlog`. */
  upsertFromItem(sourceId: string, item: WorkItem): Task {
    const existing = this.bySourceItem(sourceId, item.id);
    if (existing) {
      this.db
        .prepare(
          "UPDATE tasks SET title = ?, url = ?, priority = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
        )
        .run(item.title, item.url, item.priority, existing.id);
      return this.byId(existing.id)!;
    }
    const res = this.db
      .prepare(
        "INSERT INTO tasks (source_id, item_id, title, url, phase, priority) VALUES (?, ?, ?, ?, 'backlog', ?)",
      )
      .run(sourceId, item.id, item.title, item.url, item.priority);
    const task = this.byId(Number(res.lastInsertRowid))!;
    this.logEvent(task.id, null, "backlog", "engine", "discovered in source");
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
    // "set if the key is present in the patch, else keep the current value" —
    // this lets a caller explicitly *clear* a field (e.g. agent_name/stage when
    // a stage finishes) by passing null, which COALESCE could not express.
    const keep = <K extends keyof TaskPatch>(key: K, current: unknown): string | number | null =>
      (key in patch ? (patch[key] ?? null) : (current ?? null)) as string | number | null;
    this.db
      .prepare(
        `UPDATE tasks SET phase = ?,
           workspace_id  = ?,
           pane_id       = ?,
           agent_name    = ?,
           stage         = ?,
           dispatched_at = ?,
           resume_phase  = ?,
           branch        = ?,
           pr_url        = ?,
           error         = ?,
           updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      )
      .run(
        to,
        keep("workspaceId", task.workspaceId),
        keep("paneId", task.paneId),
        keep("agentName", task.agentName),
        keep("stage", task.stage),
        keep("dispatchedAt", task.dispatchedAt),
        keep("resumePhase", task.resumePhase),
        keep("branch", task.branch),
        keep("prUrl", task.prUrl),
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

  /**
   * Update a task's herdr coordinates without a phase change (no lifecycle
   * validation, no audit event). Used to record dispatch coordinates on a task
   * that stays in its current lane. Same "present-key wins" semantics as the
   * patch in `transition`.
   */
  update(id: number, patch: Partial<TaskPatch>): Task {
    const task = this.byId(id);
    if (!task) throw new Error(`task ${id} not found`);
    const keep = <K extends keyof TaskPatch>(key: K, current: unknown): string | number | null =>
      (key in patch ? (patch[key] ?? null) : (current ?? null)) as string | number | null;
    this.db
      .prepare(
        `UPDATE tasks SET
           workspace_id = ?, pane_id = ?, agent_name = ?, stage = ?, dispatched_at = ?,
           resume_phase = ?, branch = ?, pr_url = ?, error = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      )
      .run(
        keep("workspaceId", task.workspaceId),
        keep("paneId", task.paneId),
        keep("agentName", task.agentName),
        keep("stage", task.stage),
        keep("dispatchedAt", task.dispatchedAt),
        keep("resumePhase", task.resumePhase),
        keep("branch", task.branch),
        keep("prUrl", task.prUrl),
        "error" in patch ? (patch.error ?? null) : (task.error ?? null),
        id,
      );
    return this.byId(id)!;
  }

  /** Record (or refresh) the herdr tab/agent that runs one stage of a task. */
  recordStage(taskId: number, stage: Stage, coords: { paneId?: string; agentName?: string }): void {
    this.db
      .prepare(
        `INSERT INTO task_stages (task_id, stage, pane_id, agent_name) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, stage) DO UPDATE SET
           pane_id = COALESCE(excluded.pane_id, pane_id),
           agent_name = COALESCE(excluded.agent_name, agent_name)`,
      )
      .run(taskId, stage, coords.paneId ?? null, coords.agentName ?? null);
  }

  stagesFor(taskId: number): TaskStage[] {
    const rows = this.db
      .prepare("SELECT * FROM task_stages WHERE task_id = ? ORDER BY id")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      taskId: r.task_id as number,
      stage: r.stage as Stage,
      paneId: r.pane_id as string | null,
      agentName: r.agent_name as string | null,
      createdAt: r.created_at as string,
    }));
  }

  /** Find the task whose current stage agent is `agentName` (inbox sender check). */
  byAgent(agentName: string): Task | null {
    const r = this.db.prepare("SELECT * FROM tasks WHERE agent_name = ?").get(agentName) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToTask(r) : null;
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
  workspaceId: string | null;
  paneId: string | null;
  agentName: string | null;
  stage: Stage | null;
  dispatchedAt: string | null;
  resumePhase: Phase | null;
  branch: string | null;
  prUrl: string | null;
  error: string | null;
}
