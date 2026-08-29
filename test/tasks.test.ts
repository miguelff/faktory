import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import { TaskStore } from "../src/core/tasks.ts";
import type { WorkItem } from "../src/core/types.ts";

function makeStore() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sources (id, kind, config) VALUES ('s1', 'notion', '{}')").run();
  return new TaskStore(db);
}

const item: WorkItem = {
  id: "page-1",
  title: "Fix the flux capacitor",
  url: "https://notion.so/page-1",
  status: null,
  ownedBy: null,
  ownedAt: null,
  priority: 3,
  updatedAt: null,
};

test("upsert discovers once (into backlog), refreshes afterwards", () => {
  const store = makeStore();
  const a = store.upsertFromItem("s1", item);
  assert.equal(a.phase, "backlog");
  const b = store.upsertFromItem("s1", { ...item, title: "Fix it better", priority: 9 });
  assert.equal(b.id, a.id);
  assert.equal(b.title, "Fix it better");
  assert.equal(b.priority, 9);
  assert.equal(store.list().length, 1);
});

test("transition enforces the lifecycle and records events", () => {
  const store = makeStore();
  const t = store.upsertFromItem("s1", item);
  store.transition(t.id, "shape", "test");
  assert.throws(() => store.transition(t.id, "release", "test"), /illegal transition/);
  store.transition(t.id, "execute", "test", { patch: { branch: "faktory-x/1-fix" } });
  const now = store.byId(t.id)!;
  assert.equal(now.phase, "execute");
  assert.equal(now.branch, "faktory-x/1-fix");
  assert.deepEqual(
    store.events(t.id).map((e) => e.to),
    ["backlog", "shape", "execute"],
  );
});

test("patch can clear a field (agent detaches when a stage finishes)", () => {
  const store = makeStore();
  const t = store.upsertFromItem("s1", item);
  store.transition(t.id, "shape", "test", { patch: { agentName: "a-1", stage: "shape" } });
  assert.equal(store.byId(t.id)!.agentName, "a-1");
  store.transition(t.id, "execute", "test", { patch: { agentName: null, stage: null } });
  const now = store.byId(t.id)!;
  assert.equal(now.agentName, null);
  assert.equal(now.stage, null);
});

test("update patches herdr coordinates without a phase change or event", () => {
  const store = makeStore();
  const t = store.upsertFromItem("s1", item);
  store.transition(t.id, "shape", "test");
  store.update(t.id, { workspaceId: "ws1", paneId: "p1", agentName: "a1", stage: "shape" });
  const now = store.byId(t.id)!;
  assert.equal(now.phase, "shape");
  assert.equal(now.workspaceId, "ws1");
  assert.equal(now.agentName, "a1");
  assert.deepEqual(
    store.events(t.id).map((e) => e.to),
    ["backlog", "shape"],
    "update() records no audit event",
  );
});

test("stage tabs are recorded per task/stage", () => {
  const store = makeStore();
  const t = store.upsertFromItem("s1", item);
  store.recordStage(t.id, "shape", { paneId: "p1", agentName: "a1" });
  store.recordStage(t.id, "execute", { paneId: "p2", agentName: "a2" });
  store.recordStage(t.id, "shape", { paneId: "p1b" }); // upsert keeps agent, updates pane
  const stages = store.stagesFor(t.id);
  assert.equal(stages.length, 2);
  const shape = stages.find((s) => s.stage === "shape")!;
  assert.equal(shape.paneId, "p1b");
  assert.equal(shape.agentName, "a1");
  // byAgent resolves the task from its *current* stage agent (inbox origin check).
  store.update(t.id, { agentName: "a2" });
  assert.equal(store.byAgent("a2")?.id, t.id);
  assert.equal(store.byAgent("nobody"), null);
});

test("force transition bypasses validation but is audited", () => {
  const store = makeStore();
  const t = store.upsertFromItem("s1", item);
  store.transition(t.id, "done", "repair", { force: true, note: "manual repair" });
  assert.match(store.events(t.id).at(-1)!.note!, /^\[forced\] manual repair$/);
});
