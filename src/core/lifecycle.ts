import { PHASES, STAGES, type Phase, type Role, type Stage, type Task } from "./types.ts";

/**
 * The lifecycle state machine as data. Every task phase change must be listed
 * here; `transition()` in tasks.ts enforces it and records an audit event.
 *
 * The straight pipeline is backlog → shape → execute → review →
 * release → done. Only a human moves a task out of `backlog` (and from `done`
 * to `archived`); shaping is an interactive session that ends — on the human's
 * word in the agent's chat — back in `backlog` or on to `execute`, and never
 * blocks. `blocked` opens an interactive unblocking session and can return to
 * any lane; `archived` can be revived back to `backlog`.
 */
export const TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  backlog: ["shape"],
  shape: ["backlog", "execute"],
  execute: ["review", "blocked"],
  review: ["release", "execute", "blocked"],
  release: ["done", "blocked"],
  done: ["archived"],
  blocked: ["backlog", "shape", "execute", "review", "release", "archived"],
  archived: ["backlog"], // revival
};

/** Moves reserved for a human (TUI/API); the loop and agents never make them. */
export const HUMAN_ONLY: ReadonlyArray<readonly [Phase, Phase]> = [
  ["backlog", "shape"],
  ["done", "archived"],
];

export function canTransition(from: Phase, to: Phase): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Can an agent route a task from → to via a handoff? (legal and not human-only) */
export function canHandoff(from: Phase, to: Phase): boolean {
  return canTransition(from, to) && !HUMAN_ONLY.some(([f, t]) => f === from && t === to);
}

/** Is this phase an actionable lane (the loop dispatches a stage agent here)? */
export function isStage(phase: Phase): phase is Stage {
  return (STAGES as readonly string[]).includes(phase);
}

/**
 * The role the loop dispatches for each phase — the pipeline lanes get their
 * stage agent, `blocked` gets the interactive unblocking session. Phases with
 * no role (`backlog`, `done`, `archived`) are never worked by an agent.
 */
export const ROLE_FOR_PHASE: Readonly<Partial<Record<Phase, Role>>> = {
  shape: "shape",
  execute: "execute",
  review: "review",
  release: "release",
  blocked: "unblock",
};

export function roleFor(phase: Phase): Role | null {
  return ROLE_FOR_PHASE[phase] ?? null;
}

/**
 * Is an agent actively working this task? A lane task is either *being worked*
 * (an agent is dispatched) or *waiting* in the loop's inbox. This is the
 * explicit signal the loop and the board use — never inferred from silence.
 */
export function isWorking(task: Task): boolean {
  return task.dispatchedAt != null && task.agentName != null;
}

/** A lane task that still needs an agent dispatched (the loop's pick list). */
export function isWaiting(task: Task): boolean {
  return isStage(task.phase) && !isWorking(task);
}

/**
 * The faktory_status value in the work source per phase. Every entry starts
 * (and stays) `discoverable` until an instance claims it; from then on the
 * source mirrors the owning instance's phase verbatim. `backlog` is the
 * pre-claim state, so it maps to `discoverable`.
 */
export const DISCOVERABLE = "discoverable";

export function statusForPhase(phase: Phase): string {
  return phase === "backlog" ? DISCOVERABLE : phase;
}

/**
 * Inverse of statusForPhase: the phase a datasource `faktory_status` represents.
 * The datasource is the source of truth, so this is how the local projection
 * adopts state read back from it (a discoverable/empty status is `backlog`).
 * Unknown values fall back to `backlog` rather than corrupting the projection.
 */
export function phaseForStatus(status: string | null): Phase {
  if (!status || status === DISCOVERABLE) return "backlog";
  // Pre-rename statuses (to_shape/to_execute/to_review, ready) may still be
  // stored in shared datasources; adopt them under their new phase names.
  const name = status === "ready" ? "release" : status.startsWith("to_") ? status.slice(3) : status;
  return (PHASES as readonly string[]).includes(name) ? (name as Phase) : "backlog";
}

/** All values faktory_status can take in the source. */
export const FAKTORY_STATUSES: readonly string[] = [
  DISCOVERABLE,
  ...PHASES.filter((p) => p !== "backlog"),
];
