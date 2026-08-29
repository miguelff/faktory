import type { DatabaseSync } from "node:sqlite";
import { TaskStore } from "./tasks.ts";
import type { Phase, Task } from "./types.ts";
import { PHASE_TAG_ROLE, tagForRole } from "./lifecycle.ts";
import type { WorkSource } from "../sources/types.ts";

/**
 * The deterministic engine: sync candidates from the source, keep source tags
 * and status mirrored to the internal lifecycle. No judgement here — the
 * orchestrator agent (or the API caller) decides *what* to dispatch; this
 * module keeps the books straight.
 */
export interface EngineConfig {
  prefix: string; // faktory-<slug>
  /** Native status label per phase (optional, source-facing). */
  statusByPhase?: Partial<Record<Phase, string>>;
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

  /** Pull the candidate list and upsert tasks. Returns newly discovered tasks. */
  async syncCandidates(): Promise<Task[]> {
    const items = await this.source.listCandidates();
    const fresh: Task[] = [];
    for (const item of items) {
      const existing = this.tasks.bySourceItem(this.source.id, item.id);
      const task = this.tasks.upsertFromItem(this.source.id, item);
      if (!existing) fresh.push(task);
    }
    return fresh;
  }

  /**
   * Transition a task and mirror the change to the source:
   * remove the previous mirror tag, add the new one, update native status.
   */
  async transition(taskId: number, to: Phase, actor: string, note?: string): Promise<Task> {
    const before = this.tasks.byId(taskId);
    if (!before) throw new Error(`task ${taskId} not found`);
    const task = this.tasks.transition(taskId, to, actor, { note });
    await this.mirror(before.phase, task);
    return task;
  }

  private async mirror(fromPhase: Phase, task: Task): Promise<void> {
    const { prefix } = this.cfg;
    const oldRole = PHASE_TAG_ROLE[fromPhase];
    const newRole = PHASE_TAG_ROLE[task.phase];

    if (this.source.removeTag && oldRole && oldRole !== newRole) {
      await this.source.removeTag(task.itemId, tagForRole(prefix, oldRole));
    }
    // Consume the candidacy tag the moment work starts, preventing double dispatch.
    if (this.source.removeTag && task.phase === "dispatching") {
      await this.source.removeTag(task.itemId, tagForRole(prefix, "execute"));
    }
    if (this.source.addTag && newRole && newRole !== oldRole) {
      await this.source.addTag(task.itemId, tagForRole(prefix, newRole));
    }
    const status = this.cfg.statusByPhase?.[task.phase];
    if (status) await this.source.setStatus(task.itemId, status);
  }
}
