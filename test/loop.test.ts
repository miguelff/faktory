import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import { Engine } from "../src/core/engine.ts";
import { Loop, type AgentStatus, type Dispatcher, type StageDispatchResult } from "../src/core/loop.ts";
import type { Stage, Task, WorkItem } from "../src/core/types.ts";
import type { WorkSource } from "../src/sources/types.ts";

class FakeSource implements WorkSource {
  readonly kind = "fake";
  readonly id = "primary";
  items: WorkItem[] = [];
  owners: Record<string, string> = {};
  statuses: Record<string, string> = {};
  comments: Array<{ id: string; body: string }> = [];
  async listCandidates() {
    return this.items.filter((i) => !this.owners[i.id] || this.owners[i.id] === "faktory-test");
  }
  async getItem(id: string) {
    return this.items.find((i) => i.id === id) ?? null;
  }
  async claim(id: string) {
    return (this.owners[id] ??= "faktory-test");
  }
  async setStatus(id: string, status: string) {
    this.statuses[id] = status;
  }
  async comment(id: string, body: string) {
    this.comments.push({ id, body });
  }
}

class FakeDispatcher implements Dispatcher {
  dispatched: Array<{ taskId: number; stage: Stage; agentName: string }> = [];
  status = new Map<string, AgentStatus>();
  archived: number[] = [];
  nudges: string[] = [];
  agentNameFor(taskId: number, stage: Stage): string {
    return `a-t${taskId}-${stage}`;
  }
  async dispatchStage(task: Task, stage: Stage, _prompt: string): Promise<StageDispatchResult> {
    const agentName = this.agentNameFor(task.id, stage);
    this.dispatched.push({ taskId: task.id, stage, agentName });
    this.status.set(agentName, "working");
    return { workspaceId: `ws${task.id}`, paneId: `ws${task.id}:p-${stage}`, agentName, branch: `b/${task.id}` };
  }
  async archiveTaskSpace(task: Task) {
    this.archived.push(task.id);
  }
  async agentStatus(agentName: string): Promise<AgentStatus> {
    return this.status.get(agentName) ?? "working";
  }
  async nudge(agentName: string) {
    this.nudges.push(agentName);
  }
}

function item(id: string, title: string, priority: number): WorkItem {
  return { id, title, url: `u-${id}`, status: null, ownedBy: null, ownedAt: null, priority, updatedAt: null };
}

function harness(wip: number, now: () => number = Date.now) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sources (id, kind, config) VALUES ('primary','fake','{}')").run();
  const source = new FakeSource();
  const engine = new Engine(db, source, { prefix: "faktory-test" });
  const dispatcher = new FakeDispatcher();
  const loop = new Loop(
    engine,
    dispatcher,
    {
      wip,
      stallTimeoutMs: 1000,
      reportCommandFor: (t, s, a) => `report ${t.id} ${s} ${a}`,
    },
    now,
  );
  return { engine, source, dispatcher, loop };
}

/** Post a typed inbox message as the current stage agent would (through the API path). */
function report(engine: Engine, task: Task, type: "completed" | "needs_human" | "note", note = "") {
  engine.inbox.enqueue({ taskId: task.id, type, stage: task.stage, sender: task.agentName, note });
}

test("a task flows the full pipeline, one stage agent dispatched per lane", async () => {
  const { engine, source, dispatcher, loop } = harness(3);
  source.items = [item("n1", "One", 5)];

  await loop.tick(); // sync → backlog; promote → to_shape; dispatch shaping agent
  let t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "to_shape");
  assert.equal(t.agentName, "a-t1-to_shape");
  assert.notEqual(t.dispatchedAt, null, "explicitly marked as being worked");
  assert.equal(source.owners.n1, "faktory-test", "ownership claimed on leaving backlog");

  report(engine, t, "completed", "shaped it");
  await loop.tick(); // apply completed → to_execute; dispatch execute agent
  t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "to_execute");
  assert.equal(t.agentName, "a-t1-to_execute");

  report(engine, t, "completed", "built it");
  await loop.tick(); // → to_review; dispatch reviewer
  t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "to_review");

  report(engine, t, "completed", "review passed");
  await loop.tick(); // → ready; ready is not actionable → no dispatch
  t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "ready");
  assert.equal(t.agentName, null, "agent detached once past the actionable lanes");
  assert.equal(t.dispatchedAt, null);

  assert.deepEqual(
    dispatcher.dispatched.map((d) => d.stage),
    ["to_shape", "to_execute", "to_review"],
    "exactly one agent per actionable lane",
  );
});

test("WIP caps how many tasks occupy the actionable lanes", async () => {
  const { engine, loop, source } = harness(2);
  source.items = [item("a", "A", 3), item("b", "B", 2), item("c", "C", 1)];
  await loop.tick();
  const actionable = engine.tasks.list().filter((t) => ["to_shape", "to_execute", "to_review"].includes(t.phase));
  assert.equal(actionable.length, 2, "only WIP tasks are pulled into the lanes");
  assert.equal(engine.tasks.list("backlog").length, 1, "the rest wait in backlog");
});

test("higher priority is promoted from backlog first", async () => {
  const { engine, loop, source } = harness(1);
  source.items = [item("low", "Low", 1), item("high", "High", 9)];
  await loop.tick();
  const inLane = engine.tasks.list("to_shape");
  assert.equal(inLane.length, 1);
  assert.equal(inLane[0]!.itemId, "high");
});

test("handoff payloads are injected into the next stage's prompt", async () => {
  const { engine, source, loop } = harness(3);
  source.items = [item("n1", "One", 5)];
  await loop.tick();
  let t = engine.tasks.byId(1)!;
  report(engine, t, "completed", "SHAPED-SPEC-XYZ");
  await loop.tick();
  // The completed message is preserved as the trail and fed forward.
  const trail = engine.inbox.forTask(1);
  assert.ok(trail.some((m) => m.note === "SHAPED-SPEC-XYZ"));
  assert.ok(source.comments.some((c) => c.body.includes("SHAPED-SPEC-XYZ")), "annotated on the source");
});

test("needs_human moves the task to blocked and remembers the resume lane", async () => {
  const { engine, source, loop } = harness(3);
  source.items = [item("n1", "One", 5)];
  await loop.tick();
  const t = engine.tasks.byId(1)!;
  report(engine, t, "needs_human", "which database?");
  await loop.tick();
  const after = engine.tasks.byId(1)!;
  assert.equal(after.phase, "blocked");
  assert.equal(after.resumePhase, "to_shape");
  assert.equal(after.agentName, null, "detached while blocked");
});

test("a message from the wrong sender is rejected, not applied", async () => {
  const { engine, source, loop } = harness(3);
  source.items = [item("n1", "One", 5)];
  await loop.tick();
  const t = engine.tasks.byId(1)!;
  engine.inbox.enqueue({ taskId: t.id, type: "completed", stage: "to_shape", sender: "impostor", note: "x" });
  await loop.tick();
  assert.equal(engine.tasks.byId(1)!.phase, "to_shape", "unchanged");
  assert.match(engine.inbox.forTask(1).at(-1)!.outcome!, /rejected:sender-mismatch/);
});

test("completion is never inferred from silence; a quiet agent is nudged then stalled", async () => {
  let clock = 0;
  const { engine, source, dispatcher, loop } = harness(3, () => clock);
  source.items = [item("n1", "One", 5)];
  await loop.tick();
  const agent = engine.tasks.byId(1)!.agentName!;
  // Agent goes idle without sending a completed message.
  dispatcher.status.set(agent, "idle");
  await loop.tick(); // first quiet sighting → nudge, still in lane
  assert.deepEqual(dispatcher.nudges, [agent]);
  assert.equal(engine.tasks.byId(1)!.phase, "to_shape", "not moved on silence");

  clock += 2000; // exceed stallTimeoutMs
  await loop.tick();
  const after = engine.tasks.byId(1)!;
  assert.equal(after.phase, "blocked", "flagged for a human after the timeout");
});

test("herdr-blocked surfaces as needs-human regardless of the inbox", async () => {
  const { engine, source, dispatcher, loop } = harness(3);
  source.items = [item("n1", "One", 5)];
  await loop.tick();
  const agent = engine.tasks.byId(1)!.agentName!;
  dispatcher.status.set(agent, "blocked");
  await loop.tick();
  assert.equal(engine.tasks.byId(1)!.phase, "blocked");
});
