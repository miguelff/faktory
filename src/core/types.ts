/** Faktory lifecycle phases (source-independent, stored in SQLite). */
export const PHASES = [
  "discovered",
  "queued",
  "dispatching",
  "running",
  "reviewing",
  "blocked",
  "ready_to_deploy",
  "deploying",
  "done",
  "failed",
  "cancelled",
] as const;

export type Phase = (typeof PHASES)[number];

export const TERMINAL_PHASES: readonly Phase[] = ["done", "failed", "cancelled"];

/** A normalized unit of work coming from any source. */
export interface WorkItem {
  /** Source-native id (Notion page id, GitHub issue node id, Jira key…). */
  id: string;
  title: string;
  url: string;
  /** faktory_status value in the source (null = discoverable). */
  status: string | null;
  /** Instance that owns the item (faktory_owned_by), null while discoverable. */
  ownedBy: string | null;
  /** When ownership was stamped (faktory_owned_at). */
  ownedAt: string | null;
  /** Larger number = more important. Sources map their own scale. */
  priority: number | null;
  /**
   * Source-native ids of the items this one depends on ("depends-on" /
   * "blocked by"): they must be finished before this item may be worked. The
   * relation is source-specific (a Notion relation, a GitHub issue reference,
   * a Jira link) but the normalized shape is always a flat list of ids.
   * `undefined` means the source did not report dependencies (leave whatever is
   * already tracked untouched); `[]` means it has none.
   */
  dependsOn?: string[];
  updatedAt: string | null;
  /** Untouched source payload for debugging / advanced policy. */
  raw?: unknown;
}

export interface Task {
  id: number;
  sourceId: string;
  itemId: string;
  title: string;
  url: string;
  phase: Phase;
  priority: number | null;
  /** herdr coordinates once dispatched */
  workspaceId: string | null;
  paneId: string | null;
  agentName: string | null;
  branch: string | null;
  prUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: number;
  taskId: number;
  at: string;
  from: Phase | null;
  to: Phase;
  actor: string;
  note: string | null;
}
