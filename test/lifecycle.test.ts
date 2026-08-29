import { test } from "node:test";
import assert from "node:assert/strict";
import { TRANSITIONS, canTransition, tagForRole, PHASE_TAG_ROLE } from "../src/core/lifecycle.ts";
import { PHASES, TERMINAL_PHASES } from "../src/core/types.ts";

test("every phase has a transition entry", () => {
  for (const p of PHASES) assert.ok(p in TRANSITIONS, p);
});

test("all transition targets are valid phases", () => {
  for (const targets of Object.values(TRANSITIONS)) {
    for (const t of targets) assert.ok(PHASES.includes(t), t);
  }
});

test("done is terminal", () => {
  assert.equal(TRANSITIONS.done.length, 0);
});

test("failed and cancelled can be retried into queued", () => {
  assert.ok(canTransition("failed", "queued"));
  assert.ok(canTransition("cancelled", "queued"));
});

test("happy path is legal end to end", () => {
  const path = ["discovered", "queued", "dispatching", "running", "reviewing", "ready_to_deploy", "deploying", "done"] as const;
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(canTransition(path[i]!, path[i + 1]!), `${path[i]} → ${path[i + 1]}`);
  }
});

test("illegal jumps are rejected", () => {
  assert.equal(canTransition("discovered", "running"), false);
  assert.equal(canTransition("done", "queued"), false);
});

test("tag derivation uses the instance prefix", () => {
  assert.equal(tagForRole("faktory-omnia", "execute"), "faktory-omnia-execute");
  assert.equal(tagForRole("faktory-omnia", "review-passed"), "faktory-omnia-review-passed");
});

test("terminal phases carry no processing mirror", () => {
  for (const p of TERMINAL_PHASES) {
    assert.notEqual(PHASE_TAG_ROLE[p], "processing");
  }
});
