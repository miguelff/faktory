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

test("upsert discovers once, refreshes afterwards", () => {
  const store = makeStore();
  const a = store.upsertFromItem("s1", item);
  assert.equal(a.phase, "discovered");
  const b = store.upsertFromItem("s1", { ...item, title: "Fix it better", priority: 9 });
  assert.equal(b.id, a.id);
  assert.equal(b.title, "Fix it better");
  assert.equal(b.priority, 9);
  assert.equal(store.list().length, 1);
});

test("createAt inserts a task at a phase with a null -> phase created event", () => {
  const store = makeStore();
  const t = store.createAt("s1", { ...item, id: "page-new" }, "queued", "api");
  assert.equal(t.phase, "queued");
  assert.equal(t.itemId, "page-new");
  assert.equal(t.priority, 3);
  const events = store.events(t.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.from, null);
  assert.equal(events[0]!.to, "queued");
  assert.equal(events[0]!.actor, "api");
  assert.equal(events[0]!.note, "created");
  // A custom note overrides the default.
  const t2 = store.createAt("s1", { ...item, id: "page-new-2" }, "discovered", "api", "seeded by operator");
  assert.equal(t2.phase, "discovered");
  assert.equal(store.events(t2.id)[0]!.note, "seeded by operator");
});

test("transition enforces the lifecycle and records events", () => {
  const store = makeStore();
  const t = store.upsertFromItem("s1", item);
  store.transition(t.id, "queued", "test");
  assert.throws(() => store.transition(t.id, "running", "test"), /illegal transition/);
  store.transition(t.id, "dispatching", "test", { patch: { branch: "faktory-x/1-fix" } });
  const now = store.byId(t.id)!;
  assert.equal(now.phase, "dispatching");
  assert.equal(now.branch, "faktory-x/1-fix");
  const events = store.events(t.id);
  assert.deepEqual(events.map((e) => e.to), ["discovered", "queued", "dispatching"]);
});

test("force transition bypasses validation but is audited", () => {
  const store = makeStore();
  const t = store.upsertFromItem("s1", item);
  store.transition(t.id, "done", "repair", { force: true, note: "manual repair" });
  const events = store.events(t.id);
  assert.match(events.at(-1)!.note!, /^\[forced\] manual repair$/);
});
