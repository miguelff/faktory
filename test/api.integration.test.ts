import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb } from "../src/core/db.ts";
import { Engine } from "../src/core/engine.ts";
import { createApiServer } from "../src/api/server.ts";
import type { WorkItem } from "../src/core/types.ts";
import type { WorkSource } from "../src/sources/types.ts";

/**
 * Integration test: real SQLite + real HTTP server on an ephemeral port, with
 * an in-memory WorkSource double that records claims, status writes, comments.
 */
class FakeSource implements WorkSource {
  readonly kind = "fake";
  readonly id = "primary";
  items: WorkItem[] = [];
  owners: Record<string, string> = {};
  statuses: Record<string, string> = {};
  comments: Array<{ id: string; body: string }> = [];
  nextClaimWinner: string | null = null;

  async listCandidates() {
    return this.items;
  }
  async getItem(id: string) {
    return this.items.find((i) => i.id === id) ?? null;
  }
  async claim(id: string) {
    if (this.owners[id]) return this.owners[id]!;
    this.owners[id] = this.nextClaimWinner ?? "faktory-test";
    this.nextClaimWinner = null;
    return this.owners[id]!;
  }
  async setStatus(id: string, status: string) {
    this.statuses[id] = status;
  }
  async comment(id: string, body: string) {
    this.comments.push({ id, body });
  }
}

function workItem(id: string, title: string, priority: number): WorkItem {
  return { id, title, url: `u-${id}`, status: null, ownedBy: null, ownedAt: null, priority, updatedAt: null };
}

let server: Server;
let base: string;
const source = new FakeSource();

before(async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sources (id, kind, config) VALUES ('primary', 'fake', '{}')").run();
  const engine = new Engine(db, source, { prefix: "faktory-test" });
  server = createApiServer({ engine, prefix: "faktory-test" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  return { status: res.status, body: (await res.json()) as any };
}

test("health reports prefix, the new phases, and the stages", async () => {
  const { status, body } = await api("/api/health");
  assert.equal(status, 200);
  assert.equal(body.prefix, "faktory-test");
  assert.ok(body.phases.includes("to_shape"));
  assert.ok(!body.phases.includes("running"));
  assert.deepEqual(body.stages, ["to_shape", "to_execute", "to_review"]);
});

test("sync discovers candidates into backlog", async () => {
  source.items = [workItem("n1", "One", 2), workItem("n2", "Two", 9)];
  const { body } = await api("/api/sync", { method: "POST" });
  assert.equal(body.discovered.length, 2);
  const again = await api("/api/sync", { method: "POST" });
  assert.equal(again.body.discovered.length, 0, "sync is idempotent");
  const { body: list } = await api("/api/tasks?phase=backlog");
  assert.equal(list.tasks.length, 2);
});

test("transition validates lifecycle, claims on leaving backlog, mirrors status", async () => {
  const bad = await api("/api/tasks/1/transition", {
    method: "POST",
    body: JSON.stringify({ to: "to_execute", actor: "test" }),
  });
  assert.equal(bad.status, 409, "backlog → to_execute is illegal");

  const shaped = await api("/api/tasks/1/transition", {
    method: "POST",
    body: JSON.stringify({ to: "to_shape", actor: "test" }),
  });
  assert.equal(shaped.body.task.phase, "to_shape");
  assert.equal(source.owners.n1, "faktory-test", "claimed when leaving backlog");
  assert.equal(source.statuses.n1, "to_shape", "faktory_status mirrors the phase");
});

test("a lost claim archives the local task and returns 409", async () => {
  source.items = [...source.items, workItem("n3", "Three", 1)];
  await api("/api/sync", { method: "POST" });
  const { body: list } = await api("/api/tasks");
  const t = list.tasks.find((x: any) => x.itemId === "n3");
  source.nextClaimWinner = "faktory-rival";
  const res = await api(`/api/tasks/${t.id}/transition`, {
    method: "POST",
    body: JSON.stringify({ to: "to_shape", actor: "test" }),
  });
  assert.equal(res.status, 409);
  const { body: after } = await api(`/api/tasks/${t.id}`);
  assert.equal(after.task.phase, "archived");
  assert.equal(source.owners.n3, "faktory-rival");
  assert.equal(source.statuses.n3, undefined, "never wrote to an entry it does not own");
});

test("sync archives backlog tasks that vanished from candidacy", async () => {
  source.items = [...source.items, workItem("n4", "Four", 1)];
  await api("/api/sync", { method: "POST" });
  const { body: list } = await api("/api/tasks");
  const t = list.tasks.find((x: any) => x.itemId === "n4");
  assert.equal(t.phase, "backlog");
  source.items = source.items.filter((i) => i.id !== "n4");
  await api("/api/sync", { method: "POST" });
  const { body: after } = await api(`/api/tasks/${t.id}`);
  assert.equal(after.task.phase, "archived");
});

test("board groups tasks by column", async () => {
  const { body } = await api("/api/board");
  const byPhase = Object.fromEntries(body.columns.map((c: any) => [c.phase, c.tasks.length]));
  assert.ok(byPhase.backlog >= 0);
  assert.equal(body.columns.length, 8);
});

test("invalid phase names are rejected", async () => {
  const res = await api("/api/tasks/1/transition", { method: "POST", body: JSON.stringify({ to: "warp" }) });
  assert.equal(res.status, 400);
});

test("task detail includes the audit trail and inbox", async () => {
  const { body } = await api("/api/tasks/1");
  assert.equal(body.task.id, 1);
  assert.deepEqual(
    body.events.map((e: any) => e.to),
    ["backlog", "to_shape"],
  );
  assert.ok(Array.isArray(body.inbox));
});

test("inbox endpoint validates the type and enqueues typed messages", async () => {
  const bad = await api("/api/tasks/1/inbox", { method: "POST", body: JSON.stringify({ type: "bogus" }) });
  assert.equal(bad.status, 400);

  const ok = await api("/api/tasks/1/inbox", {
    method: "POST",
    body: JSON.stringify({ type: "completed", sender: "a1", stage: "to_shape", note: "shaped", data: { pr: 1 } }),
  });
  assert.equal(ok.status, 202);
  assert.equal(ok.body.message.type, "completed");

  const { body } = await api("/api/tasks/1");
  assert.equal(body.inbox.at(-1).note, "shaped");
  assert.equal(body.inbox.at(-1).appliedAt, null, "the endpoint only enqueues; the loop applies");
});

test("inbox on a missing task returns 404", async () => {
  const res = await api("/api/tasks/9999/inbox", { method: "POST", body: JSON.stringify({ type: "note" }) });
  assert.equal(res.status, 404);
});

test("comment posts a handoff marker through the source, defaulting status from phase", async () => {
  source.comments.length = 0;
  const res = await api("/api/tasks/1/comment", {
    method: "POST",
    body: JSON.stringify({ note: "Plan approved, executing.", data: { iteration: 2 } }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.body, '<faktory status="to_shape" iteration="2">Plan approved, executing.</faktory>');
  assert.equal(source.comments.at(-1)!.id, "n1");
});

test("feed exposes recent action-feed entries", async () => {
  const { status, body } = await api("/api/feed?limit=5");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.feed));
});
