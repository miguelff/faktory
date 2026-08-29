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

/** Roles a source tag can play. Concrete tag names derive from the instance prefix. */
export const TAG_ROLES = [
  "execute",
  "processing",
  "stalled",
  "failed",
  "executed",
  "review-passed",
] as const;

export type TagRole = (typeof TAG_ROLES)[number];

/** A normalized unit of work coming from any source. */
export interface WorkItem {
  /** Source-native id (Notion page id, GitHub issue node id, Jira key…). */
  id: string;
  title: string;
  url: string;
  /** Native status label as shown in the source. */
  status: string | null;
  tags: string[];
  /** Larger number = more important. Sources map their own scale. */
  priority: number | null;
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
