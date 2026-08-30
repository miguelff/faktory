import type { DatabaseSync } from "node:sqlite";
import type { ErrorEntry, ErrorKind } from "./types.ts";

/**
 * The local error log. Inconsistencies between the datasource (the source of
 * truth) and the local snapshot are flagged here — never in the datasource.
 * The store is pure persistence; the engine decides what is an inconsistency
 * (a failed write-through, a lost CAS, a reconcile mismatch) and the TUI/API
 * let an operator resolve one.
 *
 * Recurrence is collapsed by `fingerprint`: recording an error whose
 * fingerprint already has an *open* row is a no-op that returns the existing
 * row, so a reconcile pass that runs every tick never spams duplicates.
 */
export interface ErrorDraft {
  taskId?: number | null;
  kind: ErrorKind;
  fingerprint?: string | null;
  message: string;
  detail?: string | null;
}

function rowToError(r: Record<string, unknown>): ErrorEntry {
  return {
    id: r.id as number,
    taskId: (r.task_id as number | null) ?? null,
    at: r.at as string,
    kind: r.kind as ErrorKind,
    fingerprint: (r.fingerprint as string | null) ?? null,
    message: r.message as string,
    detail: (r.detail as string | null) ?? null,
    resolvedAt: (r.resolved_at as string | null) ?? null,
  };
}

export class ErrorStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Flag an inconsistency. Idempotent per open `fingerprint`. */
  record(draft: ErrorDraft): ErrorEntry {
    if (draft.fingerprint) {
      const open = this.openByFingerprint(draft.fingerprint);
      if (open) return open;
    }
    const res = this.db
      .prepare("INSERT INTO errors (task_id, kind, fingerprint, message, detail) VALUES (?, ?, ?, ?, ?)")
      .run(
        draft.taskId ?? null,
        draft.kind,
        draft.fingerprint ?? null,
        draft.message,
        draft.detail ?? null,
      );
    return this.byId(Number(res.lastInsertRowid))!;
  }

  byId(id: number): ErrorEntry | null {
    const r = this.db.prepare("SELECT * FROM errors WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToError(r) : null;
  }

  openByFingerprint(fingerprint: string): ErrorEntry | null {
    const r = this.db
      .prepare("SELECT * FROM errors WHERE fingerprint = ? AND resolved_at IS NULL ORDER BY id DESC")
      .get(fingerprint) as Record<string, unknown> | undefined;
    return r ? rowToError(r) : null;
  }

  /** Open (unresolved) errors, newest first. */
  open(): ErrorEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM errors WHERE resolved_at IS NULL ORDER BY id DESC")
      .all() as Record<string, unknown>[];
    return rows.map(rowToError);
  }

  /** Open errors of one kind — used by the reconcile job to sweep stale ones. */
  openByKind(kind: ErrorKind): ErrorEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM errors WHERE kind = ? AND resolved_at IS NULL ORDER BY id")
      .all(kind) as Record<string, unknown>[];
    return rows.map(rowToError);
  }

  all(limit = 100): ErrorEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM errors ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToError);
  }

  forTask(taskId: number): ErrorEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM errors WHERE task_id = ? ORDER BY id")
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToError);
  }

  /** Mark one error resolved. Returns false when it was already resolved/absent. */
  resolve(id: number): boolean {
    const res = this.db
      .prepare(
        "UPDATE errors SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND resolved_at IS NULL",
      )
      .run(id);
    return res.changes > 0;
  }

  /** Resolve the open error carrying `fingerprint` (a write-through that acked). */
  resolveByFingerprint(fingerprint: string): void {
    this.db
      .prepare(
        "UPDATE errors SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE fingerprint = ? AND resolved_at IS NULL",
      )
      .run(fingerprint);
  }
}
