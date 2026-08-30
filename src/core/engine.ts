import type { DatabaseSync } from "node:sqlite";
import { TaskStore, type TaskPatch } from "./tasks.ts";
import type { ErrorEntry, Task, Phase } from "./types.ts";
import { canTransition, phaseForStatus, statusForPhase } from "./lifecycle.ts";
import { renderHandoff, type Handoff } from "./handoff.ts";
import { InboxStore } from "./inbox.ts";
import { FeedStore } from "./feed.ts";
import { ErrorStore } from "./errors.ts";
import { OutboxStore, type OutboxEntry, type OutboxOp } from "./outbox.ts";
import type { WorkSource } from "../sources/types.ts";

/**
 * The deterministic engine. The datasource is the source of truth; this engine
 * keeps a local *snapshot* of it. Every task state operation goes through a
 * remote proxy: the write is enqueued in the outbox, performed against the
 * datasource, and only projected onto the local snapshot once the datasource
 * acknowledges it. A write that fails (datasource unavailable) stays pending
 * and is retried on a backoff — it is never lost and never applied locally
 * ahead of the datasource (no local-first / offline mode).
 *
 * Inconsistencies — a write-through that keeps failing, a lost CAS, or a value
 * the periodic reconciliation job finds to differ remotely vs locally — are
 * flagged in the local error log (never in the datasource) for an operator to
 * resolve. Ownership rule: every entry is discoverable by every instance, but
 * only the instance that won the claim (CAS on faktory_owned_by, on leaving
 * `backlog`) may manage it.
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

/** Retry backoff for a failed write-through, capped. */
function backoffMs(attempts: number): number {
  return Math.min(attempts * 2_000, 30_000);
}

export class Engine {
  readonly tasks: TaskStore;
  readonly inbox: InboxStore;
  readonly feed: FeedStore;
  readonly errors: ErrorStore;
  readonly outbox: OutboxStore;
  /**
   * Monotonic count of acknowledged local projections. Reconcile snapshots it
   * across the datasource read to detect a write that raced the read (the API
   * server can apply one during the network await), so it never compares a
   * fresh local snapshot against a stale remote one.
   */
  private writeSeq = 0;

  constructor(
    db: DatabaseSync,
    readonly source: WorkSource,
    readonly cfg: EngineConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.tasks = new TaskStore(db);
    this.inbox = new InboxStore(db);
    this.feed = new FeedStore(db);
    this.errors = new ErrorStore(db);
    this.outbox = new OutboxStore(db);
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
      // The datasource is the source of truth: a task we already own carries its
      // phase in faktory_status, so a newly-projected row adopts it (recovery
      // after a wiped local DB). Unowned entries are discoverable → backlog.
      const initialPhase = item.ownedBy === this.cfg.prefix ? phaseForStatus(item.status) : "backlog";
      const task = this.tasks.upsertFromItem(this.source.id, item, initialPhase);
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
   * Transition a task. Datasource-first: the move is enqueued in the outbox,
   * written to the source (leaving `backlog` first claims ownership via CAS),
   * and only projected locally once acknowledged. A lost claim archives the
   * local task and throws ClaimLostError. When the datasource is unavailable
   * the write stays pending (retried by `flushOutbox`) and the projection does
   * not advance — the returned task reflects the not-yet-applied state.
   */
  async transition(
    taskId: number,
    to: Phase,
    actor: string,
    note?: string,
    patch?: Partial<TaskPatch>,
    opts: { force?: boolean } = {},
  ): Promise<Task> {
    const before = this.tasks.byId(taskId);
    if (!before) throw new Error(`task ${taskId} not found`);
    if (!opts.force && !canTransition(before.phase, to)) {
      throw new Error(`illegal transition ${before.phase} → ${to} for task ${taskId}`);
    }
    // A backlog entry we never claimed isn't ours to write remotely; archiving
    // it (only reachable via force) is a purely local drop.
    if (before.phase === "backlog" && to === "archived") {
      this.tasks.transition(taskId, to, actor, { note, patch, force: true });
      this.feed.append({ taskId, kind: "transition", actor, message: `backlog → archived${note ? ` — ${note}` : ""}` });
      return this.tasks.byId(taskId)!;
    }
    const claimFirst = before.phase === "backlog" && !opts.force;
    const res = await this.writeThrough({
      kind: "transition",
      itemId: before.itemId,
      taskId,
      to,
      actor,
      note: note ?? null,
      patch,
      claimFirst,
      force: opts.force,
    });
    if (res.claimLost) throw new ClaimLostError(taskId, res.claimLost);
    return this.tasks.byId(taskId)!;
  }

  /**
   * Release the claim on a backlog task: clear faktory_owned_by/_owned_at in the
   * datasource so the entry is discoverable again. Only legal from `backlog`.
   * Written through the outbox like every other datasource write.
   */
  async unclaim(taskId: number): Promise<void> {
    const task = this.tasks.byId(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (task.phase !== "backlog") {
      throw new Error(`only a backlog task can be unclaimed (task ${taskId} is in ${task.phase})`);
    }
    await this.writeThrough({ kind: "unclaim", itemId: task.itemId, taskId });
  }

  /**
   * Leave a papertrail comment on a task's work unit (a `<handoff from to>`
   * marker). A missing `from` defaults to the task's current role (or phase).
   * The comment is written through the outbox — durable and retried — so the
   * papertrail can never be silently dropped. Returns the rendered marker.
   */
  async comment(
    taskId: number,
    handoff: Handoff,
    opts: { feedMessage?: string | null; feedActor?: string | null } = {},
  ): Promise<string> {
    const task = this.tasks.byId(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    const body = renderHandoff({ ...handoff, from: handoff.from ?? task.stage ?? task.phase });
    await this.writeThrough({
      kind: "comment",
      itemId: task.itemId,
      taskId,
      body,
      feedMessage: opts.feedMessage ?? null,
      feedActor: opts.feedActor ?? null,
    });
    return body;
  }

  // --- the remote proxy: write remotely, retry until acknowledged, then local ---

  /** Enqueue a remote write and attempt it now. */
  private async writeThrough(op: OutboxOp): Promise<{ acked: boolean; claimLost?: string }> {
    const entry = this.outbox.enqueue(op);
    return this.flushEntry(entry);
  }

  /** Retry every pending outbox op whose backoff has elapsed. */
  async flushOutbox(): Promise<void> {
    const nowIso = new Date(this.now()).toISOString();
    for (const entry of this.outbox.pendingDue(nowIso)) {
      await this.flushEntry(entry);
    }
  }

  /** Perform one op's remote write; on ack apply its local effect, else retry. */
  private async flushEntry(entry: OutboxEntry): Promise<{ acked: boolean; claimLost?: string }> {
    try {
      const outcome = await this.applyRemote(entry.op);
      this.applyLocal(entry.op, outcome);
      this.outbox.markAcknowledged(entry.id);
      this.errors.resolveByFingerprint(`outbox:${entry.id}`);
      return { acked: true, claimLost: outcome.claimLost };
    } catch (e) {
      const attempts = entry.attempts + 1;
      const nextAt = new Date(this.now() + backoffMs(attempts)).toISOString();
      this.outbox.markFailed(entry.id, (e as Error).message, nextAt);
      this.errors.record({
        taskId: entry.taskId,
        kind: "write-through",
        fingerprint: `outbox:${entry.id}`,
        message: `datasource write failed (${entry.op.kind}), will retry: ${(e as Error).message}`,
        detail: JSON.stringify(entry.op),
      });
      this.feed.append({
        taskId: entry.taskId,
        kind: "error",
        actor: "engine",
        message: `datasource write failed (${entry.op.kind}), queued for retry: ${(e as Error).message}`,
      });
      return { acked: false };
    }
  }

  /** The remote half: talk to the datasource. Throws when it is unavailable. */
  private async applyRemote(op: OutboxOp): Promise<{ claimLost?: string }> {
    switch (op.kind) {
      case "transition": {
        if (op.claimFirst) {
          const owner = await this.source.claim(op.itemId);
          if (owner !== this.cfg.prefix) return { claimLost: owner };
        }
        await this.source.setStatus(op.itemId, statusForPhase(op.to));
        return {};
      }
      case "comment":
        await this.source.comment(op.itemId, op.body);
        return {};
      case "unclaim":
        await this.source.unclaim(op.itemId);
        return {};
    }
  }

  /** The local half: project the acknowledged write onto the snapshot. */
  private applyLocal(op: OutboxOp, outcome: { claimLost?: string }): void {
    this.writeSeq++;
    switch (op.kind) {
      case "transition": {
        if (outcome.claimLost) {
          this.tasks.transition(op.taskId, "archived", "engine", {
            force: true,
            note: `claim lost to ${outcome.claimLost}`,
          });
          this.errors.record({
            taskId: op.taskId,
            kind: "cas",
            fingerprint: `cas:${op.taskId}`,
            message: `CAS failed: entry claimed by ${outcome.claimLost}`,
          });
          this.feed.append({ taskId: op.taskId, kind: "transition", actor: "engine", message: `claim lost to ${outcome.claimLost}` });
          return;
        }
        const from = this.tasks.byId(op.taskId)?.phase ?? op.to;
        this.tasks.transition(op.taskId, op.to, op.actor, { note: op.note ?? undefined, patch: op.patch, force: op.force });
        this.feed.append({
          taskId: op.taskId,
          kind: "transition",
          actor: op.actor,
          message: `${from} → ${op.to}${op.note ? ` — ${op.note}` : ""}`,
        });
        return;
      }
      case "comment": {
        if (op.feedMessage) {
          this.feed.append({
            taskId: op.taskId,
            kind: "annotation",
            actor: op.feedActor ?? "engine",
            message: op.feedMessage,
          });
        }
        return;
      }
      case "unclaim": {
        this.feed.append({ taskId: op.taskId, kind: "transition", actor: "human", message: "claim released — discoverable again" });
        return;
      }
    }
  }

  // --- reconciliation: audit the datasource against the local snapshot ------

  /**
   * The periodic reconciliation job. Reads the datasource and, for every task
   * this instance manages, flags an error when a value differs remotely vs
   * locally (phase, ownership, or the entry gone missing). Datasource-first
   * write-through means these should never diverge from Faktory's own actions,
   * so a mismatch is a real inconsistency — a dropped write, an out-of-band
   * edit, or another instance. Reconcile errors that no longer reproduce are
   * swept resolved. Never mutates task state — only flags.
   */
  async reconcile(): Promise<ErrorEntry[]> {
    const seqBefore = this.writeSeq;
    let items;
    try {
      items = await this.source.listCandidates();
    } catch {
      return []; // datasource unreachable — write-through retries own recovery
    }
    // A write acknowledged during the read moved the local snapshot ahead of
    // the `items` we just fetched: comparing them would be a false positive.
    // Skip this pass; the next tick audits a quiescent, consistent state.
    if (this.writeSeq !== seqBefore) return [];
    const byItem = new Map(items.map((i) => [i.id, i]));
    const flagged: ErrorEntry[] = [];
    const seen = new Set<string>();
    const flag = (fp: string, taskId: number, message: string, detail?: unknown) => {
      seen.add(fp);
      flagged.push(
        this.errors.record({ taskId, kind: "reconcile", fingerprint: fp, message, detail: detail ? JSON.stringify(detail) : null }),
      );
    };
    for (const task of this.tasks.list()) {
      // Only owned, in-flight tasks are mirrored in the datasource candidates:
      // backlog is unclaimed, done/archived have left the board locally.
      if (task.phase === "backlog" || task.phase === "done" || task.phase === "archived") continue;
      const remote = byItem.get(task.itemId);
      if (!remote) {
        flag(`reconcile:${task.id}:missing`, task.id, `task not found in datasource (claimed away, deleted, or set done remotely)`);
        continue;
      }
      const remotePhase = phaseForStatus(remote.status);
      if (remotePhase !== task.phase) {
        flag(`reconcile:${task.id}:phase`, task.id, `phase differs: local ${task.phase} vs datasource ${remotePhase}`, {
          localPhase: task.phase,
          remoteStatus: remote.status,
          remotePhase,
        });
      }
      if (remote.ownedBy !== this.cfg.prefix) {
        flag(`reconcile:${task.id}:owner`, task.id, `owner differs: datasource ${remote.ownedBy ?? "(unowned)"} vs expected ${this.cfg.prefix}`, {
          remoteOwnedBy: remote.ownedBy,
          expected: this.cfg.prefix,
        });
      }
    }
    // Sweep: a reconcile error whose inconsistency was repaired is now resolved.
    for (const err of this.errors.openByKind("reconcile")) {
      if (err.fingerprint && !seen.has(err.fingerprint)) this.errors.resolve(err.id);
    }
    return flagged;
  }
}
