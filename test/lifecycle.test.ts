import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TRANSITIONS,
  canTransition,
  canHandoff,
  roleFor,
  isInteractive,
  statusForPhase,
  phaseForStatus,
  DISCOVERABLE,
  FAKTORY_STATUSES,
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
  const path = ["backlog", "shape", "execute", "review", "release", "done"] as const;
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
  assert.equal(canTransition("backlog", "execute"), false);
  assert.equal(canTransition("backlog", "done"), false);
  assert.equal(canTransition("done", "backlog"), false);
});

test("every phase's role matches the spec", () => {
  assert.equal(roleFor("backlog"), null, "backlog is never worked by an agent");
  assert.equal(roleFor("shape"), "shape");
  assert.equal(roleFor("execute"), "execute");
  assert.equal(roleFor("review"), "review");
  assert.equal(roleFor("release"), "release");
  assert.equal(roleFor("blocked"), "unblock");
  assert.equal(roleFor("done"), null);
  assert.equal(roleFor("archived"), null);
  assert.ok(isInteractive("shape") && isInteractive("unblock"), "shape and unblock talk to the human");
  assert.ok(!isInteractive("execute") && !isInteractive("review") && !isInteractive("release"));
});

test("isStage identifies the actionable lanes only", () => {
  for (const s of STAGES) assert.ok(isStage(s));
  assert.equal(isStage("backlog"), false);
  assert.equal(isStage("blocked"), false);
  assert.equal(isStage("done"), false);
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

test("phaseForStatus adopts pre-rename to_* statuses under the new lane names", () => {
  assert.equal(phaseForStatus("to_shape"), "shape");
  assert.equal(phaseForStatus("to_execute"), "execute");
  assert.equal(phaseForStatus("to_review"), "review");
  assert.equal(phaseForStatus("shape"), "shape");
  assert.equal(phaseForStatus("to_nonsense"), "backlog");
  assert.equal(phaseForStatus(DISCOVERABLE), "backlog");
});

test("phaseForStatus adopts the pre-rename ready status as release", () => {
  assert.equal(phaseForStatus("ready"), "release");
  assert.equal(phaseForStatus("release"), "release");
});

test("the transition table encodes the spec", () => {
  assert.deepEqual(TRANSITIONS.backlog, ["shape"]);
  assert.deepEqual(TRANSITIONS.shape, ["backlog", "execute"]);
  assert.deepEqual(TRANSITIONS.execute, ["review", "blocked"]);
  assert.deepEqual(TRANSITIONS.review, ["release", "execute", "blocked"]);
  assert.deepEqual(TRANSITIONS.release, ["done", "blocked"]);
  assert.deepEqual(TRANSITIONS.done, ["archived"]);
  assert.equal(canTransition("shape", "blocked"), false, "shaping never blocks");
});

test("human-only moves are excluded from agent handoffs", () => {
  assert.equal(canHandoff("backlog", "shape"), false, "only a human promotes from backlog");
  assert.equal(canHandoff("done", "archived"), false, "only a human archives a done task");
  assert.equal(canHandoff("shape", "backlog"), true);
  assert.equal(canHandoff("review", "execute"), true);
  assert.equal(canHandoff("blocked", "execute"), true);
});
