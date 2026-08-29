import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import { InboxStore, isInboxType } from "../src/core/inbox.ts";
import { FeedStore } from "../src/core/feed.ts";

function makeDb() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sources (id, kind, config) VALUES ('s1', 'notion', '{}')").run();
  db.prepare("INSERT INTO tasks (source_id, item_id, title, url, phase) VALUES ('s1','p1','T','u','to_shape')").run();
  return db;
}

test("isInboxType only accepts the typed message kinds", () => {
  for (const t of ["completed", "needs_human", "note"]) assert.ok(isInboxType(t));
  assert.equal(isInboxType("done"), false);
  assert.equal(isInboxType(42), false);
});

test("enqueue → pending → resolve is the drain cycle", () => {
  const db = makeDb();
  const inbox = new InboxStore(db);
  const m = inbox.enqueue({ taskId: 1, type: "completed", stage: "to_shape", sender: "a1", note: "done", data: { pr: 9 } });
  assert.equal(m.appliedAt, null);
  assert.deepEqual(m.data, { pr: 9 });

  assert.equal(inbox.pending().length, 1);
  inbox.resolve(m.id, "applied");
  assert.equal(inbox.pending().length, 0, "resolved messages are no longer pending");
  assert.equal(inbox.byId(m.id)!.outcome, "applied");
});

test("forTask returns the full handoff trail in order", () => {
  const db = makeDb();
  const inbox = new InboxStore(db);
  inbox.enqueue({ taskId: 1, type: "note", note: "first" });
  inbox.enqueue({ taskId: 1, type: "completed", note: "second" });
  assert.deepEqual(
    inbox.forTask(1).map((m) => m.note),
    ["first", "second"],
  );
});

test("feed append + recent returns newest first, capped", () => {
  const db = makeDb();
  const feed = new FeedStore(db);
  for (let i = 0; i < 5; i++) feed.append({ taskId: 1, kind: "transition", actor: "engine", message: `m${i}` });
  const recent = feed.recent(3);
  assert.equal(recent.length, 3);
  assert.deepEqual(
    recent.map((e) => e.message),
    ["m4", "m3", "m2"],
  );
});
