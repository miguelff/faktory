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
 * with an in-memory WorkSource double that records tag/status mirroring.
 */
class FakeSource implements WorkSource {
  readonly kind = "fake";
  readonly id = "primary";
  items: WorkItem[] = [];
  tagOps: string[] = [];
  statuses: Record<string, string> = {};

  async listCandidates() {
    return this.items;
  }
  async getItem(id: string) {
    return this.items.find((i) => i.id === id) ?? null;
  }
  async setStatus(id: string, status: string) {
    this.statuses[id] = status;
  }
  async addTag(id: string, tag: string) {
    this.tagOps.push(`+${id}:${tag}`);
  }
  async removeTag(id: string, tag: string) {
    this.tagOps.push(`-${id}:${tag}`);
  }
}

let server: Server;
let base: string;
const source = new FakeSource();

before(async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sources (id, kind, config) VALUES ('primary', 'fake', '{}')").run();
  const engine = new Engine(db, source, {
    prefix: "faktory-test",
    statusByPhase: { running: "Build / Do", reviewing: "Review", done: "Done" },
  });
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
  source.items = [
    { id: "n1", title: "One", url: "u1", status: "New", tags: [], priority: 2, updatedAt: null },
    { id: "n2", title: "Two", url: "u2", status: "New", tags: [], priority: 9, updatedAt: null },
  ];
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

  // Mirroring: candidacy tag consumed at dispatching, processing tag added, status updated.
  assert.ok(source.tagOps.includes("-n1:faktory-test-execute"));
  assert.ok(source.tagOps.includes("+n1:faktory-test-processing"));
  assert.equal(source.statuses.n1, "Build / Do");
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

test("dispatch without herdr returns 503", async () => {
  const res = await api("/api/tasks/2/dispatch", { method: "POST", body: "{}" });
  assert.equal(res.status, 503);
});
