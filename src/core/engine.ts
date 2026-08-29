import type { DatabaseSync } from "node:sqlite";
import { TaskStore, type TaskPatch } from "./tasks.ts";
import type { Task, Phase } from "./types.ts";
import { statusForPhase } from "./lifecycle.ts";
import { renderHandoff, type Handoff } from "./handoff.ts";
import { InboxStore } from "./inbox.ts";
import { FeedStore } from "./feed.ts";
import type { WorkSource } from "../sources/types.ts";

/**
 * The deterministic engine: sync candidates from the source, keep the source's
 * faktory_status mirrored to the internal lifecycle, and own the inbox + action
 * feed the loop and TUI read. Ownership rule: every entry is discoverable by
 * every instance, but only the instance that won the claim (CAS on
 * faktory_owned_by, performed the moment a task leaves `backlog`) may manage it.
 * No judgement here — the loop (core/loop.ts) decides *what* to do; this module
 * keeps the books straight and validated.
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
  readonly inbox: InboxStore;
  readonly feed: FeedStore;

  constructor(
    db: DatabaseSync,
    readonly source: WorkSource,
    readonly cfg: EngineConfig,
  ) {
    this.tasks = new TaskStore(db);
    this.inbox = new InboxStore(db);
    this.feed = new FeedStore(db);
  }

  /**
   * Pull the candidate list (unowned entries + entries this instance owns) and
   * upsert tasks. Local `backlog` tasks whose entry disappeared from candidacy —
   * claimed by another instance, or deleted — are archived. Returns newly
   * discovered tasks.
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
    for (const task of this.tasks.list("backlog")) {
      if (!seen.has(task.itemId)) {
        this.tasks.transition(task.id, "archived", "engine", {
          force: true,
          note: "no longer discoverable (claimed by another instance or removed)",
        });
      }
    }
    if (fresh.length) {
      this.feed.append({
        kind: "sync",
        actor: "engine",
        message: `discovered ${fresh.length} new task(s)`,
      });
    }
    return fresh;
  }

  /**
   * Transition a task and mirror faktory_status to the source. Leaving
   * `backlog` first claims ownership (CAS); a lost claim archives the local
   * task and throws ClaimLostError. Records an action-feed entry.
   */
  async transition(
    taskId: number,
    to: Phase,
    actor: string,
    note?: string,
    patch?: Partial<TaskPatch>,
  ): Promise<Task> {
    const before = this.tasks.byId(taskId);
    if (!before) throw new Error(`task ${taskId} not found`);
    if (before.phase === "backlog") {
      // Dropping a backlog task locally touches nothing we don't own.
      if (to === "archived") return this.recordTransition(taskId, before.phase, to, actor, note, patch);
      const owner = await this.source.claim(before.itemId);
      if (owner !== this.cfg.prefix) {
        this.tasks.transition(taskId, "archived", "engine", {
          force: true,
          note: `claim lost to ${owner}`,
        });
        this.feed.append({ taskId, kind: "transition", actor: "engine", message: `claim lost to ${owner}` });
        throw new ClaimLostError(taskId, owner);
      }
    }
    const task = this.recordTransition(taskId, before.phase, to, actor, note, patch);
    await this.source.setStatus(task.itemId, statusForPhase(task.phase));
    return task;
  }

  private recordTransition(
    taskId: number,
    from: Phase,
    to: Phase,
    actor: string,
    note?: string,
    patch?: Partial<TaskPatch>,
  ): Task {
    const task = this.tasks.transition(taskId, to, actor, { note, patch });
    this.feed.append({
      taskId,
      kind: "transition",
      actor,
      message: `${from} → ${to}${note ? ` — ${note}` : ""}`,
    });
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
