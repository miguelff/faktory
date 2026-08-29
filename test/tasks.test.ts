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

test("upsert reconciles the cached phase from the datasource status", () => {
  const store = makeStore();
  const t = store.upsertFromItem("s1", item);
  assert.equal(t.phase, "discovered");
  // The datasource advanced this entry out of band (e.g. another operator, or
  // a rebuilt DB): the projection must follow the source, not the other way.
  const reconciled = store.upsertFromItem("s1", { ...item, status: "running", ownedBy: "faktory-x" });
  assert.equal(reconciled.phase, "running");
  const events = store.events(t.id);
  assert.deepEqual(
    events.map((e) => [e.to, e.actor]),
    [
      ["discovered", "source"],
      ["running", "source"],
    ],
  );
  assert.equal(events.at(-1)!.note, "reconciled from datasource");
});

test("a task first seen already in flight is reconciled, not re-discovered", () => {
  const store = makeStore();
  const t = store.upsertFromItem("s1", { ...item, status: "reviewing", ownedBy: "faktory-x" });
  assert.equal(t.phase, "reviewing");
  const events = store.events(t.id);
  assert.deepEqual(events.map((e) => e.to), ["reviewing"]);
  assert.equal(events[0]!.note, "reconciled from datasource");
});

test("record writes the projection and audits, without lifecycle validation", () => {
  const store = makeStore();
  const t = store.upsertFromItem("s1", item);
  // record is a projection write — the engine has already validated against the
  // authoritative source, so record itself does not gate the move.
  store.record(t.id, "running", "test", { patch: { branch: "faktory-x/1-fix" } });
  const now = store.byId(t.id)!;
  assert.equal(now.phase, "running");
  assert.equal(now.branch, "faktory-x/1-fix");
  const events = store.events(t.id);
  assert.deepEqual(events.map((e) => e.to), ["discovered", "running"]);
});

test("force record is audited with a [forced] marker", () => {
  const store = makeStore();
  const t = store.upsertFromItem("s1", item);
  store.record(t.id, "done", "repair", { force: true, note: "manual repair" });
  const events = store.events(t.id);
  assert.match(events.at(-1)!.note!, /^\[forced\] manual repair$/);
});
