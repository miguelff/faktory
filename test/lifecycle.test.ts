import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TRANSITIONS,
  canTransition,
  statusForPhase,
  DISCOVERABLE,
  FAKTORY_STATUSES,
  STAGE_COMPLETION,
  isStage,
} from "../src/core/lifecycle.ts";
import { PHASES, STAGES, TERMINAL_PHASES } from "../src/core/types.ts";

test("every phase has a transition entry", () => {
  for (const p of PHASES) assert.ok(p in TRANSITIONS, p);
});

test("all transition targets are valid phases", () => {
  for (const targets of Object.values(TRANSITIONS)) {
    for (const t of targets) assert.ok(PHASES.includes(t), t);
  }
});

test("the happy pipeline is legal end to end", () => {
  const path = ["backlog", "to_shape", "to_execute", "to_review", "ready", "done"] as const;
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(canTransition(path[i]!, path[i + 1]!), `${path[i]} → ${path[i + 1]}`);
  }
});

test("done only leaves to archived", () => {
  assert.deepEqual([...TRANSITIONS.done], ["archived"]);
});

test("blocked can return to any actionable lane and archived can be revived", () => {
  for (const s of STAGES) assert.ok(canTransition("blocked", s), `blocked → ${s}`);
  assert.ok(canTransition("archived", "backlog"));
});

test("illegal jumps are rejected", () => {
  assert.equal(canTransition("backlog", "to_execute"), false);
  assert.equal(canTransition("backlog", "done"), false);
  assert.equal(canTransition("done", "backlog"), false);
});

test("stage completion advances along the pipeline", () => {
  assert.equal(STAGE_COMPLETION.to_shape, "to_execute");
  assert.equal(STAGE_COMPLETION.to_execute, "to_review");
  assert.equal(STAGE_COMPLETION.to_review, "ready");
  for (const [stage, next] of Object.entries(STAGE_COMPLETION)) {
    assert.ok(canTransition(stage as any, next), `${stage} → ${next} must be legal`);
  }
});

test("isStage identifies the three actionable lanes only", () => {
  for (const s of STAGES) assert.ok(isStage(s));
  assert.equal(isStage("backlog"), false);
  assert.equal(isStage("ready"), false);
});

test("backlog mirrors as discoverable, every other phase verbatim", () => {
  assert.equal(statusForPhase("backlog"), DISCOVERABLE);
  for (const p of PHASES) {
    if (p !== "backlog") assert.equal(statusForPhase(p), p);
  }
});

test("faktory_status covers discoverable plus every non-backlog phase", () => {
  assert.ok(FAKTORY_STATUSES.includes(DISCOVERABLE));
  for (const p of TERMINAL_PHASES) assert.ok(FAKTORY_STATUSES.includes(p));
  assert.ok(!FAKTORY_STATUSES.includes("backlog"));
});
