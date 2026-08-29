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
 * The faktory_status value in the work source per phase. Every entry starts
 * (and stays) `discoverable` until an instance claims it; from then on the
 * source mirrors the owning instance's phase verbatim.
 */
export const DISCOVERABLE = "discoverable";

export function statusForPhase(phase: Phase): string {
  return phase === "discovered" ? DISCOVERABLE : phase;
}

/**
 * Inverse of {@link statusForPhase}: the lifecycle phase a datasource
 * `faktory_status` represents. The datasource is authoritative for state, so
 * this is how the engine (and the local projection) learn a task's phase — an
 * unset/`discoverable` status is `discovered`; anything else is the phase
 * verbatim. Unknown labels degrade to `discovered` rather than corrupt state.
 */
export function phaseForStatus(status: string | null): Phase {
  if (status === null || status === DISCOVERABLE) return "discovered";
  return (PHASES as readonly string[]).includes(status) ? (status as Phase) : "discovered";
}

/** All values faktory_status can take in the source. */
export const FAKTORY_STATUSES: readonly string[] = [
  DISCOVERABLE,
  ...PHASES.filter((p) => p !== "discovered"),
];
