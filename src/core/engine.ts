import type { DatabaseSync } from "node:sqlite";
import { TaskStore, type TaskPatch } from "./tasks.ts";
import type { Task } from "./types.ts";
import type { Phase } from "./types.ts";
import { canTransition, phaseForStatus, statusForPhase } from "./lifecycle.ts";
import { renderHandoff, type Handoff } from "./handoff.ts";
import type { WorkSource } from "../sources/types.ts";

/**
 * The deterministic engine. The **datasource is the source of truth** for
 * lifecycle state (its `faktory_status`) and ownership; the local SQLite table
 * is only a reconciled projection (see tasks.ts). So the engine reads the
 * authoritative phase back from the source before validating a move, mirrors
 * every committed move to the source, and records the projection afterwards.
 *
 * Ownership rule: every entry is discoverable by every instance, but only the
 * instance that won the claim (CAS on faktory_owned_by, performed the moment a
 * task moves away from discovered) may manage it. No judgement here — the
 * orchestrator agent (or the API caller) decides *what* to dispatch; this
 * module keeps the books straight.
 */
export interface EngineConfig {
  prefix: string; // faktory-<slug>
}

export class ClaimLostError extends Error {
  constructor(
    readonly taskId: number,
    readonly owner: string,
  ) {
    super(`task ${taskId} was claimed by ${owner}`);
  }
}

export class Engine {
  readonly tasks: TaskStore;

  constructor(
    db: DatabaseSync,
    private readonly source: WorkSource,
    private readonly cfg: EngineConfig,
  ) {
    this.tasks = new TaskStore(db);
  }

  /**
   * Pull the candidate list (unowned entries + entries this instance owns)
   * and upsert tasks. Local `discovered` tasks whose entry disappeared from
   * candidacy — claimed by another instance, or deleted — are cancelled.
   * Returns newly discovered tasks.
   */
  async syncCandidates(): Promise<Task[]> {
    const items = await this.source.listCandidates();
    const fresh: Task[] = [];
    for (const item of items) {
      const existing = this.tasks.bySourceItem(this.source.id, item.id);
      const task = this.tasks.upsertFromItem(this.source.id, item);
      if (!existing) fresh.push(task);
    }
    const seen = new Set(items.map((i) => i.id));
    for (const task of this.tasks.list("discovered")) {
      if (!seen.has(task.itemId)) {
        this.tasks.record(task.id, "cancelled", "engine", {
          force: true,
          note: "no longer discoverable (claimed by another instance or removed)",
        });
      }
    }
    return fresh;
  }

  /**
   * Transition a task, treating the datasource as authoritative:
   *
   *  1. read the item back from the source and reconcile the local projection,
   *  2. validate the move against the source's *live* phase (not the cache),
   *  3. bail if the source says another instance now owns the entry,
   *  4. claim ownership (CAS) when leaving `discovered`,
   *  5. mirror the new `faktory_status` to the source,
   *  6. record the committed move in the local projection.
   *
   * A lost claim cancels the local task and throws ClaimLostError. `force`
   * skips lifecycle validation (repair) but still writes to the datasource, so
   * a repair fixes the shared source of truth, not just the local cache.
   */
  async transition(
    taskId: number,
    to: Phase,
    actor: string,
    opts: { note?: string; force?: boolean; patch?: Partial<TaskPatch> } = {},
  ): Promise<Task> {
    const before = this.tasks.byId(taskId);
    if (!before) throw new Error(`task ${taskId} not found`);

    // The datasource is authoritative: read it back and reconcile before acting.
    const item = await this.source.getItem(before.itemId);
    if (item) this.tasks.upsertFromItem(this.source.id, item);
    const current = item ? phaseForStatus(item.status) : before.phase;

    // Someone else owns it now — the source has moved on without us.
    if (item?.ownedBy && item.ownedBy !== this.cfg.prefix) {
      this.tasks.record(taskId, "cancelled", "engine", {
        force: true,
        note: `owned by ${item.ownedBy}`,
      });
      throw new ClaimLostError(taskId, item.ownedBy);
    }

    if (!opts.force && !canTransition(current, to)) {
      throw new Error(`illegal transition ${current} → ${to} for task ${taskId}`);
    }

    // Cancelling a still-discoverable (unowned) task is a purely local decision
    // — we never claimed it, so we must not write to an entry we don't own.
    if (current === "discovered" && to === "cancelled") {
      return this.tasks.record(taskId, to, actor, { note: opts.note, force: opts.force, patch: opts.patch });
    }

    if (current === "discovered") {
      const owner = await this.source.claim(before.itemId);
      if (owner !== this.cfg.prefix) {
        this.tasks.record(taskId, "cancelled", "engine", {
          force: true,
          note: `claim lost to ${owner}`,
        });
        throw new ClaimLostError(taskId, owner);
      }
    }

    await this.source.setStatus(before.itemId, statusForPhase(to));
    return this.tasks.record(taskId, to, actor, { note: opts.note, force: opts.force, patch: opts.patch });
  }

  /**
   * Leave a handoff-trail comment on a task's work unit. Missing `agent` and
   * `status` default to the task's agent name and mirrored phase status, so the
   * loop can pass just a note. Returns the rendered marker that was posted.
   */
  async comment(taskId: number, handoff: Handoff): Promise<string> {
    const task = this.tasks.byId(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    const body = renderHandoff({
      ...handoff,
      agent: handoff.agent ?? task.agentName,
      status: handoff.status ?? statusForPhase(task.phase),
    });
    await this.source.comment(task.itemId, body);
    return body;
  }
}
