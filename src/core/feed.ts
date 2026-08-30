import type { DatabaseSync } from "node:sqlite";
import type { FeedEntry } from "./types.ts";

/**
 * The action feed: an append-only log of what the loop and agents did
 * (syncs, transitions, dispatches, inbox verdicts, stalls). The TUI renders
 * the tail alongside the kanban board so an operator can watch the loop work.
 */
export type FeedKind = "sync" | "transition" | "dispatch" | "inbox" | "annotation" | "stall" | "repair" | "error";

export interface FeedDraft {
  taskId?: number | null;
  kind: FeedKind;
  actor: string;
  message: string;
}

function rowToEntry(r: Record<string, unknown>): FeedEntry {
  return {
    id: r.id as number,
    at: r.at as string,
    taskId: (r.task_id as number | null) ?? null,
    kind: r.kind as string,
    actor: r.actor as string,
    message: r.message as string,
  };
}

export class FeedStore {
  constructor(private readonly db: DatabaseSync) {}

  append(draft: FeedDraft): FeedEntry {
    const res = this.db
      .prepare("INSERT INTO feed (task_id, kind, actor, message) VALUES (?, ?, ?, ?)")
      .run(draft.taskId ?? null, draft.kind, draft.actor, draft.message);
    const row = this.db.prepare("SELECT * FROM feed WHERE id = ?").get(Number(res.lastInsertRowid)) as Record<
      string,
      unknown
    >;
    return rowToEntry(row);
  }

  /** Most recent entries, newest first, capped at `limit`. */
  recent(limit = 50): FeedEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM feed ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToEntry);
  }
}
