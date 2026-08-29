import { PHASES, type Phase } from "./types.ts";

/**
 * The lifecycle state machine as data. Every task phase change must be listed
 * here; `transition()` in tasks.ts enforces it and records an audit event.
 */
export const TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  discovered: ["queued", "cancelled"],
  queued: ["dispatching", "discovered", "cancelled"],
  dispatching: ["running", "failed", "queued"],
  running: ["reviewing", "blocked", "failed", "cancelled"],
  reviewing: ["ready_to_deploy", "running", "blocked", "failed"],
  blocked: ["running", "reviewing", "queued", "failed", "cancelled"],
  ready_to_deploy: ["deploying", "blocked", "cancelled"],
  deploying: ["done", "failed", "blocked"],
  done: [],
  failed: ["queued"], // allow retry
  cancelled: ["queued"], // allow revival
};

export function canTransition(from: Phase, to: Phase): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Phases a task may be *created* in. Creation is not a transition (there is no
 * `from`), so it is gated separately: only the two pre-work entry phases are
 * sane. Being born in an in-flight/terminal phase (running, deploying, done, …)
 * would mean a task with herdr coordinates that never existed — an
 * inconsistent state the reconciler/orchestrator never intended.
 */
export const CREATABLE_PHASES: readonly Phase[] = ["discovered", "queued"];

export function canCreateIn(phase: Phase): boolean {
  return CREATABLE_PHASES.includes(phase);
}

/**
 * The faktory_status value in the work source per phase. Every entry starts
 * (and stays) `discoverable` until an instance claims it; from then on the
 * source mirrors the owning instance's phase verbatim.
 */
export const DISCOVERABLE = "discoverable";

export function statusForPhase(phase: Phase): string {
  return phase === "discovered" ? DISCOVERABLE : phase;
}

/** All values faktory_status can take in the source. */
export const FAKTORY_STATUSES: readonly string[] = [
  DISCOVERABLE,
  ...PHASES.filter((p) => p !== "discovered"),
];
