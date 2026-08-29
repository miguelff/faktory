import type { DatabaseSync } from "node:sqlite";
import { TaskStore } from "./tasks.ts";
import type { Task } from "./types.ts";
import type { Phase } from "./types.ts";
import { statusForPhase } from "./lifecycle.ts";
import { renderHandoff, type Handoff } from "./handoff.ts";
import type { WorkSource } from "../sources/types.ts";

/**
 * The deterministic engine: sync candidates from the source and keep the
 * source's faktory_status mirrored to the internal lifecycle. Ownership rule:
 * every entry is discoverable by every instance, but only the instance that
 * won the claim (CAS on faktory_owned_by, performed the moment a task moves
 * away from discovered) may manage it. No judgement here — the orchestrator
 * agent (or the API caller) decides *what* to dispatch; this module keeps the
 * books straight.
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
        this.tasks.transition(task.id, "cancelled", "engine", {
          force: true,
          note: "no longer discoverable (claimed by another instance or removed)",
        });
      }
    }
    return fresh;
  }

  /**
   * Transition a task and mirror faktory_status to the source. Leaving
   * `discovered` first claims ownership (CAS); a lost claim cancels the local
   * task and throws ClaimLostError.
   */
  async transition(taskId: number, to: Phase, actor: string, note?: string): Promise<Task> {
    const before = this.tasks.byId(taskId);
    if (!before) throw new Error(`task ${taskId} not found`);
    if (before.phase === "discovered") {
      // Dropping a discovered task locally touches nothing we don't own.
      if (to === "cancelled") return this.tasks.transition(taskId, to, actor, { note });
      const owner = await this.source.claim(before.itemId);
      if (owner !== this.cfg.prefix) {
        this.tasks.transition(taskId, "cancelled", "engine", {
          force: true,
          note: `claim lost to ${owner}`,
        });
        throw new ClaimLostError(taskId, owner);
      }
    }
    const task = this.tasks.transition(taskId, to, actor, { note });
    await this.source.setStatus(task.itemId, statusForPhase(task.phase));
    return task;
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
