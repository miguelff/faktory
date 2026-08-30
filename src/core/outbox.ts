import type { DatabaseSync } from "node:sqlite";
import type { Phase } from "./types.ts";
import type { TaskPatch } from "./tasks.ts";

/**
 * The outbox: durable intent for every remote write. The remote proxy in
 * engine.ts enqueues an op here, attempts it against the datasource, and only
 * projects its local effect once the datasource acknowledges it. A write that
 * fails (datasource unavailable) stays pending and is retried on a backoff.
 *
 * An op carries both the remote write to perform AND the local effect to apply
 * on acknowledgement, so the immediate attempt and every later retry replay the
 * exact same operation.
 */
export type OutboxOp =
  | {
      kind: "transition";
      itemId: string;
      taskId: number;
      to: Phase;
      actor: string;
      note?: string | null;
      patch?: Partial<TaskPatch>;
      /** Claim ownership (CAS) before writing status — the move out of backlog. */
      claimFirst?: boolean;
      /** Bypass lifecycle validation on the local projection (manual repair). */
      force?: boolean;
    }
  | {
      kind: "comment";
      itemId: string;
      taskId: number;
      body: string;
      feedMessage?: string | null;
      feedActor?: string | null;
    }
  | { kind: "unclaim"; itemId: string; taskId: number };

export interface OutboxEntry {
  id: number;
  taskId: number | null;
  op: OutboxOp;
  attempts: number;
  lastError: string | null;
  nextAt: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
}

function rowToEntry(r: Record<string, unknown>): OutboxEntry {
  return {
    id: r.id as number,
    taskId: (r.task_id as number | null) ?? null,
    op: JSON.parse(r.op as string) as OutboxOp,
    attempts: r.attempts as number,
    lastError: (r.last_error as string | null) ?? null,
    nextAt: (r.next_at as string | null) ?? null,
    createdAt: r.created_at as string,
    acknowledgedAt: (r.acknowledged_at as string | null) ?? null,
  };
}

export class OutboxStore {
  constructor(private readonly db: DatabaseSync) {}

  enqueue(op: OutboxOp): OutboxEntry {
    const res = this.db
      .prepare("INSERT INTO outbox (task_id, op) VALUES (?, ?)")
      .run("taskId" in op ? op.taskId : null, JSON.stringify(op));
    return this.byId(Number(res.lastInsertRowid))!;
  }

  byId(id: number): OutboxEntry | null {
    const r = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToEntry(r) : null;
  }

  /** Unacknowledged ops whose backoff has elapsed, in enqueue order. */
  pendingDue(nowIso: string): OutboxEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM outbox WHERE acknowledged_at IS NULL AND (next_at IS NULL OR next_at <= ?) ORDER BY id",
      )
      .all(nowIso) as Record<string, unknown>[];
    return rows.map(rowToEntry);
  }

  /** All still-pending ops (for the TUI / diagnostics). */
  pending(): OutboxEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM outbox WHERE acknowledged_at IS NULL ORDER BY id")
      .all() as Record<string, unknown>[];
    return rows.map(rowToEntry);
  }

  markAcknowledged(id: number): void {
    this.db
      .prepare("UPDATE outbox SET acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(id);
  }

  markFailed(id: number, error: string, nextAtIso: string): void {
    this.db
      .prepare("UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_at = ? WHERE id = ?")
      .run(error, nextAtIso, id);
  }
}
