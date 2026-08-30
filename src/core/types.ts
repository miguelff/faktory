/**
 * Faktory pipeline phases (source-independent, stored in SQLite).
 *
 * The happy path is a straight pipeline
 *   backlog → shape → execute → review → release → done
 * plus two out-of-band states: `blocked` (needs a human) and `archived`
 * (removed from the board). `backlog` is the pre-claim, discoverable state;
 * ownership is taken (CAS) the moment a task leaves it.
 */
export const PHASES = [
  "backlog",
  "shape",
  "execute",
  "review",
  "release",
  "done",
  "blocked",
  "archived",
] as const;

export type Phase = (typeof PHASES)[number];

/** Phases from which no work is scheduled. */
export const TERMINAL_PHASES: readonly Phase[] = ["done", "archived"];

/**
 * The actionable lanes: each one has a stage agent that does the work and
 * reports back through the inbox. The loop dispatches an agent to any lane
 * task that is waiting; only a human moves a task out of `backlog`.
 */
export const STAGES = ["shape", "execute", "review", "release"] as const;
export type Stage = (typeof STAGES)[number];

/**
 * What the loop can dispatch an agent for: a lane's stage work, or the
 * interactive unblocking session it opens on a blocked task.
 */
export type Role = Stage | "unblock";

/**
 * Full detail of a work item, fetched on demand — agents pull it as JSON via
 * `faktory task show <id> --json` instead of having it inlined into prompts.
 */
export interface WorkItemDetails {
  /** The item's title in the source. */
  title: string;
  /** The item's content as markdown (a Notion page's blocks, an issue body, …). */
  body: string;
  /** The comment feed, oldest first — the papertrail of handoffs plus human comments. */
  trail: string[];
  /** Source-native properties (a Notion page's non-faktory properties, labels, …). */
  meta: Record<string, unknown>;
}

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
  /** herdr coordinates: the per-task space + the current stage's tab/agent. */
  workspaceId: string | null;
  paneId: string | null;
  agentName: string | null;
  /** The role currently dispatched (a lane stage or `unblock`; null when none). */
  stage: Role | null;
  /**
   * When the current stage agent was dispatched — the explicit "being worked"
   * signal. Null means the task is waiting in its lane for the loop to pick it
   * up; non-null means an agent is (or was) actively on it.
   */
  dispatchedAt: string | null;
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

/** herdr coordinates for one role tab inside a task's space. */
export interface TaskStage {
  id: number;
  taskId: number;
  stage: Role;
  paneId: string | null;
  agentName: string | null;
  createdAt: string;
}

/**
 * Typed message an agent writes to the inbox. Only the loop acts on these.
 * `handoff` moves the task to another legal lane (`data.to`) — the next
 * pipeline lane when the role is done (shape → execute … release → done),
 * review back to execute for rework, blocked when only a human can resolve
 * something; `note` annotates the papertrail with no transition.
 */
export type InboxType = "handoff" | "note";

export interface InboxMessage {
  id: number;
  taskId: number;
  stage: Role | null;
  type: InboxType;
  /** herdr agent name that sent it (validated against the task's stage agent). */
  sender: string | null;
  note: string | null;
  /** Structured handoff payload for the next stage (decisions, artifacts, …). */
  data: Record<string, unknown> | null;
  createdAt: string;
  /** When the loop consumed it (null = still pending). */
  appliedAt: string | null;
  /** What the loop did: applied | rejected:<reason> | surfaced. */
  outcome: string | null;
}

/** One line in the action feed the TUI renders next to the board. */
export interface FeedEntry {
  id: number;
  at: string;
  taskId: number | null;
  kind: string;
  actor: string;
  message: string;
}
