import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import { ErrorStore } from "../src/core/errors.ts";
import { OutboxStore } from "../src/core/outbox.ts";

function store() {
  const db = openDb(":memory:");
  return new ErrorStore(db);
}

test("an error with a fingerprint is deduped while it stays open", () => {
  const errors = store();
  const a = errors.record({ kind: "reconcile", fingerprint: "task:1:phase", message: "drift" });
  const b = errors.record({ kind: "reconcile", fingerprint: "task:1:phase", message: "drift again" });
  assert.equal(a.id, b.id, "the same open fingerprint returns the existing row");
  assert.equal(errors.open().length, 1);
});

test("resolving an error lets the same fingerprint open a fresh row", () => {
  const errors = store();
  const a = errors.record({ kind: "reconcile", fingerprint: "task:1:phase", message: "drift" });
  assert.equal(errors.resolve(a.id), true);
  assert.equal(errors.resolve(a.id), false, "resolving twice is a no-op");
  const b = errors.record({ kind: "reconcile", fingerprint: "task:1:phase", message: "drift returned" });
  assert.notEqual(a.id, b.id, "a new occurrence after resolution is a new row");
  assert.equal(errors.open().length, 1);
});

test("errors without a fingerprint are never deduped", () => {
  const errors = store();
  errors.record({ kind: "write-through", message: "boom" });
  errors.record({ kind: "write-through", message: "boom" });
  assert.equal(errors.open().length, 2);
});

test("resolveByFingerprint clears the open row for an acknowledged write", () => {
  const errors = store();
  errors.record({ taskId: 3, kind: "write-through", fingerprint: "outbox:7", message: "notion down" });
  assert.equal(errors.open().length, 1);
  errors.resolveByFingerprint("outbox:7");
  assert.equal(errors.open().length, 0);
});

test("open, byKind, forTask and all read back consistently", () => {
  const errors = store();
  errors.record({ taskId: 1, kind: "reconcile", fingerprint: "r1", message: "a" });
  const w = errors.record({ taskId: 1, kind: "write-through", fingerprint: "w1", message: "b" });
  errors.record({ taskId: 2, kind: "cas", fingerprint: "c1", message: "c" });
  errors.resolve(w.id);
  assert.equal(errors.open().length, 2, "only unresolved show as open");
  assert.equal(errors.all().length, 3, "all keeps the resolved one");
  assert.deepEqual(
    errors.openByKind("reconcile").map((e) => e.message),
    ["a"],
  );
  assert.equal(errors.forTask(1).length, 2, "both task-1 errors, resolved or not");
});

test("the outbox retries a due op and skips one still backing off", () => {
  const db = openDb(":memory:");
  const outbox = new OutboxStore(db);
  const entry = outbox.enqueue({ kind: "unclaim", itemId: "n1", taskId: 1 });
  assert.equal(outbox.pending().length, 1);

  // Not yet retried → due now (next_at is null).
  assert.equal(outbox.pendingDue("2000-01-01T00:00:00.000Z").length, 1);

  outbox.markFailed(entry.id, "down", "2100-01-01T00:00:00.000Z");
  assert.equal(outbox.pendingDue("2000-01-01T00:00:00.000Z").length, 0, "still backing off → not due");
  assert.equal(outbox.pendingDue("2200-01-01T00:00:00.000Z").length, 1, "due once the backoff elapses");

  outbox.markAcknowledged(entry.id);
  assert.equal(outbox.pending().length, 0, "acknowledged ops drop out of pending");
});