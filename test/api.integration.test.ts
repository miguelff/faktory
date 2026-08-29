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
 * Integration test: real SQLite + real HTTP server on an ephemeral port,
 * with an in-memory WorkSource double that records claims and status writes.
 */
/**
 * In-memory WorkSource double. It behaves like a real source: reads reflect
 * prior writes (setStatus/claim mutate the item), and candidacy is filtered to
 * unowned or own entries — so the datasource, not the local DB, is authoritative.
 */
class FakeSource implements WorkSource {
  readonly kind = "fake";
  readonly id = "primary";
  readonly prefix = "faktory-test";
  items: WorkItem[] = [];
  owners: Record<string, string> = {};
  statuses: Record<string, string> = {};
  comments: Array<{ id: string; body: string }> = [];
  /** When set, the next claim is lost to this instance. */
  nextClaimWinner: string | null = null;

  async listCandidates() {
    return this.items.filter(
      (i) => (!i.ownedBy || i.ownedBy === this.prefix) && i.status !== "done",
    );
  }
  async getItem(id: string) {
    return this.items.find((i) => i.id === id) ?? null;
  }
  async claim(id: string) {
    if (this.owners[id]) return this.owners[id]!;
    const winner = this.nextClaimWinner ?? this.prefix;
    this.nextClaimWinner = null;
    this.owners[id] = winner;
    const item = this.items.find((i) => i.id === id);
    if (item) item.ownedBy = winner;
    return winner;
  }
  async setStatus(id: string, status: string) {
    this.statuses[id] = status;
    const item = this.items.find((i) => i.id === id);
    if (item) item.status = status;
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
  server = createApiServer({ engine, prefix: "faktory-test" }); // no herdr: dispatch returns 503
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  return { status: res.status, body: (await res.json()) as any };
}

test("health reports prefix and phases", async () => {
  const { status, body } = await api("/api/health");
  assert.equal(status, 200);
  assert.equal(body.prefix, "faktory-test");
  assert.ok(body.phases.includes("ready_to_deploy"));
});

test("sync discovers candidates as tasks", async () => {
  source.items = [workItem("n1", "One", 2), workItem("n2", "Two", 9)];
  const { body } = await api("/api/sync", { method: "POST" });
  assert.equal(body.discovered.length, 2);
  const again = await api("/api/sync", { method: "POST" });
  assert.equal(again.body.discovered.length, 0, "sync is idempotent");
  const { body: list } = await api("/api/tasks");
  assert.equal(list.tasks.length, 2);
});

test("transition endpoint validates lifecycle and mirrors to the source", async () => {
  const bad = await api("/api/tasks/1/transition", {
    method: "POST",
    body: JSON.stringify({ to: "running", actor: "test" }),
  });
  assert.equal(bad.status, 409, "discovered → running is illegal");

  await api("/api/tasks/1/transition", { method: "POST", body: JSON.stringify({ to: "queued", actor: "test" }) });
  await api("/api/tasks/1/transition", { method: "POST", body: JSON.stringify({ to: "dispatching", actor: "test" }) });
  const run = await api("/api/tasks/1/transition", {
    method: "POST",
    body: JSON.stringify({ to: "running", actor: "test" }),
  });
  assert.equal(run.body.task.phase, "running");

  // Ownership: claimed when leaving discovered, faktory_status mirrors the phase.
  assert.equal(source.owners.n1, "faktory-test");
  assert.equal(source.statuses.n1, "running");
});

test("a lost claim cancels the local task and returns 409", async () => {
  source.items = [...source.items, workItem("n3", "Three", 1)];
  await api("/api/sync", { method: "POST" });
  const { body: list } = await api("/api/tasks");
  const t = list.tasks.find((x: any) => x.itemId === "n3");
  source.nextClaimWinner = "faktory-rival";
  const res = await api(`/api/tasks/${t.id}/transition`, {
    method: "POST",
    body: JSON.stringify({ to: "queued", actor: "test" }),
  });
  assert.equal(res.status, 409);
  const { body: after } = await api(`/api/tasks/${t.id}`);
  assert.equal(after.task.phase, "cancelled");
  assert.equal(source.owners.n3, "faktory-rival");
  assert.equal(source.statuses.n3, undefined, "never wrote to an entry it does not own");
});

test("sync cancels discovered tasks that were claimed elsewhere", async () => {
  source.items = [...source.items, workItem("n4", "Four", 1)];
  await api("/api/sync", { method: "POST" });
  const { body: list } = await api("/api/tasks");
  const t = list.tasks.find((x: any) => x.itemId === "n4");
  assert.equal(t.phase, "discovered");
  // n4 vanishes from candidacy: another instance owns it now.
  source.items = source.items.filter((i) => i.id !== "n4");
  await api("/api/sync", { method: "POST" });
  const { body: after } = await api(`/api/tasks/${t.id}`);
  assert.equal(after.task.phase, "cancelled");
});

test("the datasource is authoritative: sync reconciles the local phase", async () => {
  source.items = [...source.items, workItem("n9", "Nine", 1)];
  await api("/api/sync", { method: "POST" });
  let { body: list } = await api("/api/tasks");
  const t = list.tasks.find((x: any) => x.itemId === "n9");
  assert.equal(t.phase, "discovered");
  // The datasource is advanced out of band (another operator / another tool).
  const it = source.items.find((i) => i.id === "n9")!;
  it.ownedBy = "faktory-test";
  it.status = "blocked";
  await api("/api/sync", { method: "POST" });
  ({ body: list } = await api("/api/tasks"));
  const after = list.tasks.find((x: any) => x.itemId === "n9");
  assert.equal(after.phase, "blocked", "local projection follows the datasource");
});

test("the datasource is authoritative: validation uses the source, not the cache", async () => {
  source.items = [...source.items, workItem("n10", "Ten", 1)];
  await api("/api/sync", { method: "POST" });
  const { body: list } = await api("/api/tasks");
  const t = list.tasks.find((x: any) => x.itemId === "n10");
  assert.equal(t.phase, "discovered", "stale local cache says discovered");
  // The datasource already has this entry in `running` (owned by us).
  const it = source.items.find((i) => i.id === "n10")!;
  it.ownedBy = "faktory-test";
  it.status = "running";
  // discovered → queued is legal against the cache but illegal from running.
  const res = await api(`/api/tasks/${t.id}/transition`, {
    method: "POST",
    body: JSON.stringify({ to: "queued", actor: "test" }),
  });
  assert.equal(res.status, 409, "validated against the datasource's live phase");
});

test("invalid phase names are rejected", async () => {
  const res = await api("/api/tasks/1/transition", { method: "POST", body: JSON.stringify({ to: "warp" }) });
  assert.equal(res.status, 400);
});

test("task detail includes the audit trail", async () => {
  const { body } = await api("/api/tasks/1");
  assert.equal(body.task.id, 1);
  assert.deepEqual(
    body.events.map((e: any) => e.to),
    ["discovered", "queued", "dispatching", "running"],
  );
});

test("comment posts a handoff marker through the source, defaulting status from phase", async () => {
  source.comments.length = 0;
  // task 1 is in `running` (see the transition test above); no agentName set.
  const res = await api("/api/tasks/1/comment", {
    method: "POST",
    body: JSON.stringify({ note: "Plan approved, executing.", data: { iteration: 2 } }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.body, '<faktory status="running" iteration="2">Plan approved, executing.</faktory>');
  assert.deepEqual(source.comments.at(-1), {
    id: "n1",
    body: '<faktory status="running" iteration="2">Plan approved, executing.</faktory>',
  });
});

test("comment on a missing task returns 404", async () => {
  const res = await api("/api/tasks/9999/comment", {
    method: "POST",
    body: JSON.stringify({ note: "hi" }),
  });
  assert.equal(res.status, 404);
});

test("comment with an empty body is rejected", async () => {
  const res = await api("/api/tasks/1/comment", { method: "POST", body: "{}" });
  assert.equal(res.status, 400);
});

test("dispatch without herdr returns 503", async () => {
  const res = await api("/api/tasks/2/dispatch", { method: "POST", body: "{}" });
  assert.equal(res.status, 503);
});

test("dispatch refuses to process a task that is not queued", async () => {
  // Fresh source + server so we can assert the guard runs before any side
  // effect (claim/status mirror), independent of the no-herdr 503 path.
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sources (id, kind, config) VALUES ('primary', 'fake', '{}')").run();
  const src = new FakeSource();
  src.items = [workItem("g1", "Guarded", 1)];
  const engine = new Engine(db, src, { prefix: "faktory-guard" });
  const herdrCalls: string[] = [];
  const fakeHerdr = {
    request: async (method: string) => {
      herdrCalls.push(method);
      return {} as any;
    },
  } as any;
  const guarded = createApiServer({ engine, prefix: "faktory-guard", herdr: fakeHerdr });
  await new Promise<void>((r) => guarded.listen(0, "127.0.0.1", r));
  const guardedBase = `http://127.0.0.1:${(guarded.address() as AddressInfo).port}`;
  try {
    await fetch(`${guardedBase}/api/sync`, { method: "POST" });
    const list = (await (await fetch(`${guardedBase}/api/tasks`)).json()) as any;
    const taskId = list.tasks.find((x: any) => x.itemId === "g1").id;
    const res = await fetch(`${guardedBase}/api/tasks/${taskId}/dispatch`, { method: "POST", body: "{}" });
    assert.equal(res.status, 409, "a discovered task cannot be dispatched");
    const detail = (await (await fetch(`${guardedBase}/api/tasks/${taskId}`)).json()) as any;
    assert.equal(detail.task.phase, "discovered", "task is left untouched");
    assert.equal(src.owners.g1, undefined, "no ownership claimed before queued");
    assert.equal(src.statuses.g1, undefined, "no status mirrored before queued");
    assert.deepEqual(herdrCalls, [], "no herdr work before queued");
  } finally {
    guarded.closeAllConnections();
    guarded.close();
  }
});
