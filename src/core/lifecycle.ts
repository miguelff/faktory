import { PHASES, STAGES, type Phase, type Stage, type Task } from "./types.ts";

/**
 * The lifecycle state machine as data. Every task phase change must be listed
 * here; `transition()` in tasks.ts enforces it and records an audit event.
 *
 * The straight pipeline is backlog → to_shape → to_execute → to_review →
 * ready → done. `blocked` can return to any lane; `archived` removes a task
 * from the board (and can be revived back to `backlog`).
 */
export const TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  backlog: ["to_shape", "blocked", "archived"],
  to_shape: ["to_execute", "backlog", "blocked", "archived"],
  to_execute: ["to_review", "to_shape", "blocked", "archived"],
  to_review: ["ready", "to_execute", "blocked", "archived"],
  ready: ["done", "to_review", "blocked", "archived"],
  done: ["archived"],
  blocked: ["backlog", "to_shape", "to_execute", "to_review", "ready", "archived"],
  archived: ["backlog"], // revival
};

export function canTransition(from: Phase, to: Phase): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * The phase a task advances to when its stage agent reports `completed`.
 * Encodes the straight pipeline for the three actionable lanes.
 */
export const STAGE_COMPLETION: Readonly<Record<Stage, Phase>> = {
  to_shape: "to_execute",
  to_execute: "to_review",
  to_review: "ready",
};

/** Is this phase an actionable lane (the loop dispatches a stage agent here)? */
export function isStage(phase: Phase): phase is Stage {
  return (STAGES as readonly string[]).includes(phase);
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

/** All values faktory_status can take in the source. */
export const FAKTORY_STATUSES: readonly string[] = [
  DISCOVERABLE,
  ...PHASES.filter((p) => p !== "backlog"),
];
