import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import { Engine } from "../src/core/engine.ts";
import { Loop, type AgentStatus, type Dispatcher, type StageDispatchResult } from "../src/core/loop.ts";
import type { InboxType, Role, Task, WorkItem } from "../src/core/types.ts";
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
  async unclaim(id: string) {
    delete this.owners[id];
  }
  async setStatus(id: string, status: string) {
    this.statuses[id] = status;
  }
  async comment(id: string, body: string) {
    this.comments.push({ id, body });
  }
}

class FakeDispatcher implements Dispatcher {
  dispatched: Array<{ taskId: number; stage: Role; agentName: string }> = [];
  status = new Map<string, AgentStatus>();
  archived: number[] = [];
  nudges: string[] = [];
  notifications: Array<{ title: string; body: string }> = [];
  agentNameFor(taskId: number, role: Role): string {
    return `a-t${taskId}-${role}`;
  }
  async dispatchStage(task: Task, role: Role, _prompt: string): Promise<StageDispatchResult> {
    const agentName = this.agentNameFor(task.id, role);
    this.dispatched.push({ taskId: task.id, stage: role, agentName });
    this.status.set(agentName, "working");
    return { workspaceId: `ws${task.id}`, paneId: `ws${task.id}:p-${role}`, agentName, branch: `b/${task.id}` };
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
  async notify(title: string, body: string) {
    this.notifications.push({ title, body });
  }
}

function item(id: string, title: string, priority: number): WorkItem {
  return { id, title, url: `u-${id}`, status: null, ownedBy: null, ownedAt: null, priority, updatedAt: null };
}

function harness(now: () => number = Date.now) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sources (id, kind, config) VALUES ('primary','fake','{}')").run();
  const source = new FakeSource();
  const engine = new Engine(db, source, { prefix: "faktory-test" });
  const dispatcher = new FakeDispatcher();
  const loop = new Loop(
    engine,
    dispatcher,
    {
      stallTimeoutMs: 1000,
      reportCommandFor: (t, s, a) => `report ${t.id} ${s} ${a}`,
    },
    now,
  );
  return { engine, source, dispatcher, loop };
}

/** Sync candidates and promote task 1 into shape as a human would. */
async function seedInShape(h: ReturnType<typeof harness>, items: WorkItem[]) {
  h.source.items = items;
  await h.loop.tick(); // sync → backlog (the loop never promotes)
  await h.engine.transition(1, "shape", "human", "picked up");
  await h.loop.tick(); // dispatch the shaping agent
  return h.engine.tasks.byId(1)!;
}

/** Post a typed inbox message as the current stage agent would (through the API path). */
function report(engine: Engine, task: Task, type: InboxType, note = "", data?: Record<string, unknown>) {
  engine.inbox.enqueue({ taskId: task.id, type, stage: task.stage, sender: task.agentName, note, data });
}

/** The role is done: hand the task off to `to`, as the dispatched agent. */
function handoff(engine: Engine, task: Task, to: string, note = "") {
  report(engine, task, "handoff", note, { to });
}

test("the loop never promotes from backlog — that move is a human's", async () => {
  const { engine, source, dispatcher, loop } = harness();
  source.items = [item("a", "A", 9), item("b", "B", 5)];
  await loop.tick();
  await loop.tick();
  assert.equal(engine.tasks.list("backlog").length, 2, "everything waits in backlog");
  assert.deepEqual(dispatcher.dispatched, [], "nothing dispatched");
  await engine.transition(1, "shape", "human");
  await loop.tick();
  assert.equal(engine.tasks.byId(1)!.phase, "shape");
  assert.equal(engine.tasks.byId(1)!.agentName, "a-t1-shape", "dispatched once a human promoted it");
});

test("a task flows the full pipeline, one agent per lane, release included", async () => {
  const h = harness();
  const { engine, source, dispatcher, loop } = h;
  let t = await seedInShape(h, [item("n1", "One", 5)]);
  assert.equal(t.phase, "shape");
  assert.equal(t.agentName, "a-t1-shape");
  assert.notEqual(t.dispatchedAt, null, "explicitly marked as being worked");
  assert.equal(source.owners.n1, "faktory-test", "ownership claimed on leaving backlog");

  handoff(engine, t, "execute", "shaped it");
  await loop.tick(); // apply completed → execute; dispatch execute agent
  t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "execute");
  assert.equal(t.agentName, "a-t1-execute");

  handoff(engine, t, "review", "built it");
  await loop.tick(); // → review; dispatch reviewer
  t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "review");

  handoff(engine, t, "release", "review passed");
  await loop.tick(); // → release; dispatch the merge agent
  t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "release");
  assert.equal(t.agentName, "a-t1-release");

  handoff(engine, t, "done", "merged");
  await loop.tick(); // → done
  t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "done");
  assert.equal(t.agentName, null, "agent detached once the pipeline finished");
  assert.equal(t.dispatchedAt, null);

  assert.deepEqual(
    dispatcher.dispatched.map((d) => d.stage),
    ["shape", "execute", "review", "release"],
    "exactly one agent per actionable lane",
  );
});

test("a handoff message routes review back to execute and leaves the papertrail", async () => {
  const h = harness();
  const { engine, source, loop } = h;
  let t = await seedInShape(h, [item("n1", "One", 5)]);
  handoff(engine, t, "execute", "shaped");
  await loop.tick();
  handoff(engine, engine.tasks.byId(1)!, "review", "built");
  await loop.tick();
  t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "review");

  report(engine, t, "handoff", "blocker: missing tests", { to: "execute" });
  await loop.tick();
  t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "execute", "routed back to execution");
  assert.equal(t.agentName, "a-t1-execute", "a fresh execute agent was dispatched");
  const trail = source.comments.at(-2)!.body; // last comment is not guaranteed order with dispatch
  assert.ok(
    source.comments.some((c) => c.body.includes('<handoff from="review" to="execute"') && c.body.includes("missing tests")),
    "the handoff is mirrored on the source as the papertrail",
  );
  assert.ok(trail.startsWith("<handoff"), "papertrail comments are handoff markers");
});

test("shape hands the task back to backlog on the human's word", async () => {
  const h = harness();
  const { engine, source, loop } = h;
  const t = await seedInShape(h, [item("n1", "One", 5)]);
  report(engine, t, "handoff", "human: not ready, park it", { to: "backlog" });
  await loop.tick();
  assert.equal(engine.tasks.byId(1)!.phase, "backlog");
  assert.ok(source.comments.some((c) => c.body.includes('<handoff from="shape" to="backlog"')));
});

test("a handoff to an illegal or human-only target is rejected", async () => {
  const h = harness();
  const { engine, loop } = h;
  const t = await seedInShape(h, [item("n1", "One", 5)]);
  report(engine, t, "handoff", "skip ahead", { to: "release" });
  await loop.tick();
  assert.equal(engine.tasks.byId(1)!.phase, "shape", "unchanged");
  assert.match(engine.inbox.forTask(1).at(-1)!.outcome!, /rejected:illegal\(shape->release\)/);

  report(engine, engine.tasks.byId(1)!, "handoff", "no target");
  await loop.tick();
  assert.match(engine.inbox.forTask(1).at(-1)!.outcome!, /rejected:handoff-missing-target/);
});

test("a shape agent cannot hand off to blocked — shaping never blocks", async () => {
  const h = harness();
  const { engine, loop } = h;
  const t = await seedInShape(h, [item("n1", "One", 5)]);
  report(engine, t, "handoff", "which database?", { to: "blocked" });
  await loop.tick();
  const after = engine.tasks.byId(1)!;
  assert.equal(after.phase, "shape", "stays in its lane");
  assert.match(engine.inbox.forTask(1).at(-1)!.outcome!, /rejected:illegal\(shape->blocked\)/);
});

test("a handoff to blocked records where it came from in the audit trail", async () => {
  const h = harness();
  const { engine, loop } = h;
  let t = await seedInShape(h, [item("n1", "One", 5)]);
  handoff(engine, t, "execute", "shaped");
  await loop.tick();
  t = engine.tasks.byId(1)!;
  report(engine, t, "handoff", "prod credentials missing", { to: "blocked" });
  await loop.tick();
  const after = engine.tasks.byId(1)!;
  assert.equal(after.phase, "blocked");
  const blocking = engine.tasks.events(1).findLast((e) => e.to === "blocked")!;
  assert.equal(blocking.from, "execute");
  assert.equal(blocking.note, "prod credentials missing");
});

test("a blocked task gets an interactive unblocking session, and its handoff resumes the lane", async () => {
  const h = harness();
  const { engine, source, dispatcher, loop } = h;
  let t = await seedInShape(h, [item("n1", "One", 5)]);
  handoff(engine, t, "execute", "shaped");
  await loop.tick();
  report(engine, engine.tasks.byId(1)!, "handoff", "stuck on credentials", { to: "blocked" });
  await loop.tick(); // blocked; the same tick opens the unblocking session
  t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "blocked");
  assert.equal(t.agentName, "a-t1-unblock", "an unblocking session is opened");
  assert.ok(dispatcher.dispatched.some((d) => d.stage === "unblock"));

  report(engine, t, "handoff", "human fixed the credentials", { to: "execute" });
  await loop.tick();
  t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "execute", "resumed where the human said");
  assert.ok(source.comments.some((c) => c.body.includes('<handoff from="unblock" to="execute"')));
});

test("a message from the wrong sender is rejected, not applied", async () => {
  const h = harness();
  const { engine, loop } = h;
  await seedInShape(h, [item("n1", "One", 5)]);
  engine.inbox.enqueue({ taskId: 1, type: "handoff", stage: "shape", sender: "impostor", note: "x", data: { to: "execute" } });
  await loop.tick();
  assert.equal(engine.tasks.byId(1)!.phase, "shape", "unchanged");
  assert.match(engine.inbox.forTask(1).at(-1)!.outcome!, /rejected:origin/);
});

test("completion is never inferred from silence; a quiet agent is nudged then flagged", async () => {
  let clock = 0;
  const h = harness(() => clock);
  const { engine, dispatcher, loop } = h;
  await seedInShape(h, [item("n1", "One", 5)]);
  const agent = engine.tasks.byId(1)!.agentName!;
  // Agent goes idle without sending a completed message.
  dispatcher.status.set(agent, "idle");
  await loop.tick(); // first quiet sighting → nudge, still in lane
  assert.deepEqual(dispatcher.nudges, [agent]);
  assert.equal(engine.tasks.byId(1)!.phase, "shape", "never advanced on silence");

  clock += 2000; // exceed stallTimeoutMs
  await loop.tick();
  // Flagged for a human via the feed, but the (possibly interactive) session is
  // left intact — silence is never read as completion, nor as a hard failure.
  assert.equal(engine.tasks.byId(1)!.phase, "shape");
  assert.ok(
    engine.feed.recent(20).some((e) => e.kind === "stall" && /may need attention/.test(e.message)),
    "a stall warning is surfaced for human attention",
  );
});

test("herdr-blocked on an execute task surfaces as blocked; on shape it stays in its lane", async () => {
  const h = harness();
  const { engine, dispatcher, loop } = h;
  let t = await seedInShape(h, [item("n1", "One", 5)]);
  dispatcher.status.set(t.agentName!, "blocked");
  await loop.tick();
  t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "shape", "shaping never blocks");
  assert.ok(engine.feed.recent(10).some((e) => e.kind === "stall" && /answer in its tab/.test(e.message)));

  dispatcher.status.set(t.agentName!, "working");
  handoff(engine, t, "execute", "shaped");
  await loop.tick(); // → execute
  t = engine.tasks.byId(1)!;
  dispatcher.status.set(t.agentName!, "blocked");
  await loop.tick();
  assert.equal(engine.tasks.byId(1)!.phase, "blocked");
});

test("a vanished (absent) execute agent is a hard stall → blocked", async () => {
  const h = harness();
  const { engine, dispatcher, loop } = h;
  let t = await seedInShape(h, [item("n1", "One", 5)]);
  handoff(engine, t, "execute", "shaped");
  await loop.tick();
  t = engine.tasks.byId(1)!;
  dispatcher.status.set(t.agentName!, "absent");
  await loop.tick();
  assert.equal(engine.tasks.byId(1)!.phase, "blocked");
});

test("a vanished unblocking session is reopened on the next pass", async () => {
  const h = harness();
  const { engine, dispatcher, loop } = h;
  let t = await seedInShape(h, [item("n1", "One", 5)]);
  handoff(engine, t, "execute", "shaped");
  await loop.tick();
  report(engine, engine.tasks.byId(1)!, "handoff", "stuck", { to: "blocked" });
  await loop.tick();
  const firstSession = engine.tasks.byId(1)!.agentName!;
  assert.equal(firstSession, "a-t1-unblock");
  dispatcher.status.set(firstSession, "absent");
  await loop.tick();
  t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "blocked", "still blocked");
  assert.equal(t.agentName, "a-t1-unblock", "a fresh unblocking session was opened");
  assert.equal(dispatcher.dispatched.filter((d) => d.stage === "unblock").length, 2);
});

test("a duplicate handoff does not walk the task through empty lanes", async () => {
  const h = harness();
  const { engine, loop } = h;
  const t = await seedInShape(h, [item("n1", "One", 5)]);
  // Two handoffs from the same agent in one batch: the first advances
  // shape→execute and detaches the agent; the second must be rejected
  // (no active worker) rather than moving the task again with no work.
  handoff(engine, t, "execute", "first");
  handoff(engine, t, "execute", "second (stray)");
  await loop.tick();
  assert.equal(engine.tasks.byId(1)!.phase, "execute", "only advanced one lane");
  assert.ok(
    engine.inbox.forTask(1).some((m) => m.note === "second (stray)" && /rejected:origin/.test(m.outcome ?? "")),
    "the stray completed was rejected",
  );
});

test("an unsigned state-changing message is rejected", async () => {
  const h = harness();
  const { engine, loop } = h;
  await seedInShape(h, [item("n1", "One", 5)]);
  engine.inbox.enqueue({ taskId: 1, type: "handoff", stage: "shape", sender: null, note: "no sender", data: { to: "execute" } });
  await loop.tick();
  assert.equal(engine.tasks.byId(1)!.phase, "shape", "unsigned handoff is not applied");
  assert.match(engine.inbox.forTask(1).at(-1)!.outcome!, /rejected:origin/);
});

test("handoff payloads are injected into the next stage's prompt trail", async () => {
  const h = harness();
  const { engine, source, loop } = h;
  const t = await seedInShape(h, [item("n1", "One", 5)]);
  handoff(engine, t, "execute", "SHAPED-SPEC-XYZ");
  await loop.tick();
  // The completed message is preserved as the trail and fed forward.
  const trail = engine.inbox.forTask(1);
  assert.ok(trail.some((m) => m.note === "SHAPED-SPEC-XYZ"));
  assert.ok(source.comments.some((c) => c.body.includes("SHAPED-SPEC-XYZ")), "annotated on the source");
});

test("the datasource is authoritative: a transition writes faktory_status before the projection", async () => {
  const h = harness();
  const { engine, source } = h;
  const t = await seedInShape(h, [item("n1", "One", 5)]);
  // Make the next datasource write fail: the local projection must NOT advance
  // ahead of the source of truth.
  const realSet = source.setStatus.bind(source);
  source.setStatus = async () => {
    throw new Error("notion down");
  };
  await assert.rejects(() => engine.transition(t.id, "execute", "tui"));
  assert.equal(engine.tasks.byId(1)!.phase, "shape", "projection stayed put when the datasource write failed");
  source.setStatus = realSet;
});

test("a rebuilt projection recovers an owned task's phase from the datasource", async () => {
  const { engine, source, loop } = harness();
  // The datasource already holds an owned, mid-pipeline task (as if the local DB
  // was wiped): owned by us, faktory_status = execute.
  source.items = [
    { id: "n1", title: "Recover me", url: "u", status: "execute", ownedBy: "faktory-test", ownedAt: "t", priority: 5, updatedAt: null },
  ];
  source.owners.n1 = "faktory-test";
  await loop.tick();
  const t = engine.tasks.byId(1)!;
  assert.equal(t.phase, "execute", "adopted the datasource phase, not backlog");
});

test("archiving a task closes its herdr space exactly once", async () => {
  const h = harness();
  const { engine, dispatcher, loop } = h;
  await seedInShape(h, [item("n1", "One", 5)]);
  assert.equal(engine.tasks.byId(1)!.workspaceId, "ws1", "has a space");
  engine.tasks.transition(1, "archived", "tui", { force: true, note: "manual archive" });
  await loop.tick();
  assert.deepEqual(dispatcher.archived, [1], "space closed");
  assert.equal(engine.tasks.byId(1)!.workspaceId, null, "space id cleared");
  await loop.tick();
  assert.deepEqual(dispatcher.archived, [1], "not closed again");
});

test("a human can release the claim on a backlog task; returning to backlog never does it automatically", async () => {
  const h = harness();
  const { engine, source, loop } = h;
  const t = await seedInShape(h, [item("n1", "One", 5)]);
  handoff(engine, t, "backlog", "not ready");
  await loop.tick();
  assert.equal(engine.tasks.byId(1)!.phase, "backlog");
  assert.equal(source.owners.n1, "faktory-test", "the claim survives the return to backlog");

  await engine.unclaim(1);
  assert.equal(source.owners.n1, undefined, "unclaim releases the entry to every instance");

  await engine.transition(1, "shape", "human");
  await assert.rejects(() => engine.unclaim(1), /only a backlog task/);
});

test("an awaiting-human note flags the task and notifies the human", async () => {
  const h = harness();
  const { engine, dispatcher, loop } = h;
  const t = await seedInShape(h, [item("n1", "One", 5)]);
  report(engine, t, "note", "Which database should this read from?", { awaiting: "human" });
  await loop.tick();
  assert.notEqual(engine.tasks.byId(1)!.attentionAt, null, "flagged as waiting on the human");
  assert.ok(
    dispatcher.notifications.some((n) => n.title.includes("#1") && /Which database/.test(n.body)),
    "the human is notified",
  );
  assert.ok(engine.feed.recent(10).some((e) => /waiting on you/.test(e.message)));
});

test("any later message from the agent clears the your-turn flag", async () => {
  const h = harness();
  const { engine, loop } = h;
  const t = await seedInShape(h, [item("n1", "One", 5)]);
  report(engine, t, "note", "waiting", { awaiting: "human" });
  await loop.tick();
  assert.notEqual(engine.tasks.byId(1)!.attentionAt, null);
  report(engine, engine.tasks.byId(1)!, "note", "resuming with the answer");
  await loop.tick();
  assert.equal(engine.tasks.byId(1)!.attentionAt, null, "a plain note unflags");

  report(engine, engine.tasks.byId(1)!, "note", "one more question", { awaiting: "human" });
  await loop.tick();
  handoff(engine, engine.tasks.byId(1)!, "execute", "signed off");
  await loop.tick();
  assert.equal(engine.tasks.byId(1)!.attentionAt, null, "a handoff unflags");
});

test("a stall warning also notifies the human", async () => {
  let clock = 0;
  const h = harness(() => clock);
  const { engine, dispatcher, loop } = h;
  await seedInShape(h, [item("n1", "One", 5)]);
  const agent = engine.tasks.byId(1)!.agentName!;
  dispatcher.status.set(agent, "idle");
  await loop.tick(); // nudge
  clock += 2000;
  await loop.tick(); // flag + notify
  assert.ok(dispatcher.notifications.some((n) => /may need attention/.test(n.body)));
});
