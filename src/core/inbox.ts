import type { DatabaseSync } from "node:sqlite";
import type { InboxMessage, InboxType, Stage } from "./types.ts";

/**
 * The inbox is the one channel agents use to talk back to the loop
 * (channel-style concurrency: agents never mutate state, they send messages).
 * Messages are typed; the loop selects on pending ones, validates them, and
 * serially applies the resulting mutation. This store is pure persistence —
 * validation and transition live in the loop (see core/loop.ts).
 */
export const INBOX_TYPES: readonly InboxType[] = ["completed", "needs_human", "note"];

export function isInboxType(v: unknown): v is InboxType {
  return typeof v === "string" && (INBOX_TYPES as readonly string[]).includes(v);
}

export interface InboxDraft {
  taskId: number;
  type: InboxType;
  stage?: Stage | null;
  sender?: string | null;
  note?: string | null;
  data?: Record<string, unknown> | null;
}

function rowToMessage(r: Record<string, unknown>): InboxMessage {
  return {
    id: r.id as number,
    taskId: r.task_id as number,
    stage: (r.stage as Stage | null) ?? null,
    type: r.type as InboxType,
    sender: (r.sender as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    data: r.data ? (JSON.parse(r.data as string) as Record<string, unknown>) : null,
    createdAt: r.created_at as string,
    appliedAt: (r.applied_at as string | null) ?? null,
    outcome: (r.outcome as string | null) ?? null,
  };
}

export class InboxStore {
  constructor(private readonly db: DatabaseSync) {}

  enqueue(draft: InboxDraft): InboxMessage {
    const res = this.db
      .prepare("INSERT INTO inbox (task_id, stage, type, sender, note, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        draft.taskId,
        draft.stage ?? null,
        draft.type,
        draft.sender ?? null,
        draft.note ?? null,
        draft.data ? JSON.stringify(draft.data) : null,
      );
    return this.byId(Number(res.lastInsertRowid))!;
  }

  byId(id: number): InboxMessage | null {
    const r = this.db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? rowToMessage(r) : null;
  }

  /** Pending (unconsumed) messages in arrival order — the loop drains these. */
  pending(): InboxMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM inbox WHERE applied_at IS NULL ORDER BY id")
      .all() as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }

  /** Full history for a task (for the TUI / API), newest last. */
  forTask(taskId: number): InboxMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM inbox WHERE task_id = ? ORDER BY id")
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }

  /** Mark a message consumed, recording what the loop did with it. */
  resolve(id: number, outcome: string): void {
    this.db
      .prepare("UPDATE inbox SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), outcome = ? WHERE id = ?")
      .run(outcome, id);
  }
}
