import type { Phase, TagRole } from "./types.ts";

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

/** Which tag role mirrors each phase in the work source (null = leave tags alone). */
export const PHASE_TAG_ROLE: Readonly<Partial<Record<Phase, TagRole>>> = {
  running: "processing",
  dispatching: "processing",
  blocked: "stalled",
  failed: "failed",
  reviewing: "executed",
  ready_to_deploy: "review-passed",
};

/** Derive the concrete tag name for a role from an instance prefix. */
export function tagForRole(prefix: string, role: TagRole): string {
  return `${prefix}-${role}`;
}
