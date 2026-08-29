import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import { DependenciesUnmetError, Engine } from "../src/core/engine.ts";
import type { WorkItem } from "../src/core/types.ts";
import type { WorkSource } from "../src/sources/types.ts";

/**
 * Engine unit tests for the abstract "depends-on" ordering gate: a task cannot
 * be queued until every item it depends on is finished, regardless of whether
 * the dependency is tracked locally, owned by another instance, or already done.
 */
class FakeSource implements WorkSource {
  readonly kind = "fake";
  readonly id = "primary";
  items = new Map<string, WorkItem>();
  owners: Record<string, string> = {};
  statuses: Record<string, string> = {};

  set(item: WorkItem) {
    this.items.set(item.id, item);
  }
  async listCandidates() {
    return [...this.items.values()];
  }
  async getItem(id: string) {
    return this.items.get(id) ?? null;
  }
  async claim(id: string) {
    return (this.owners[id] ??= "faktory-test");
  }
  async setStatus(id: string, status: string) {
    this.statuses[id] = status;
    const it = this.items.get(id);
    if (it) it.status = status;
  }
  async comment() {}
}

function item(id: string, dependsOn?: string[], status: string | null = null): WorkItem {
  return {
    id,
    title: `Task ${id}`,
    url: `u-${id}`,
    status,
    ownedBy: null,
    ownedAt: null,
    priority: 1,
    dependsOn,
    updatedAt: null,
  };
}

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sources (id, kind, config) VALUES ('primary','fake','{}')").run();
  const source = new FakeSource();
  const engine = new Engine(db, source, { prefix: "faktory-test" });
  return { engine, source };
}

test("syncCandidates persists depends-on edges from the source", async () => {
  const { engine, source } = setup();
  source.set(item("a"));
  source.set(item("b", ["a"]));
  await engine.syncCandidates();
  const b = engine.tasks.bySourceItem("primary", "b")!;
  assert.deepEqual(engine.tasks.dependencyItemIds(b.id), ["a"]);
});

test("queueing is blocked until the dependency is done", async () => {
  const { engine, source } = setup();
  source.set(item("a"));
  source.set(item("b", ["a"]));
  await engine.syncCandidates();
  const b = engine.tasks.bySourceItem("primary", "b")!;

  await assert.rejects(
    () => engine.transition(b.id, "queued", "test"),
    (e) => e instanceof DependenciesUnmetError && e.blockers[0]!.itemId === "a",
  );
  // The blocked task was never claimed or moved.
  assert.equal(engine.tasks.byId(b.id)!.phase, "discovered");
  assert.equal(source.owners["b"], undefined);

  // Finish the dependency, then queueing succeeds.
  const a = engine.tasks.bySourceItem("primary", "a")!;
  await engine.transition(a.id, "queued", "test");
  await engine.transition(a.id, "dispatching", "test");
  await engine.transition(a.id, "running", "test");
  await engine.transition(a.id, "reviewing", "test");
  await engine.transition(a.id, "ready_to_deploy", "test");
  await engine.transition(a.id, "deploying", "test");
  await engine.transition(a.id, "done", "test");

  const queued = await engine.transition(b.id, "queued", "test");
  assert.equal(queued.phase, "queued");
});

test("dependencies without deps queue freely", async () => {
  const { engine, source } = setup();
  source.set(item("a"));
  await engine.syncCandidates();
  const a = engine.tasks.bySourceItem("primary", "a")!;
  const queued = await engine.transition(a.id, "queued", "test");
  assert.equal(queued.phase, "queued");
});

test("a dependency marked done in the source (owned elsewhere) is satisfied", async () => {
  const { engine, source } = setup();
  // Dependency exists only in the source as done — never tracked locally.
  source.set(item("ext", undefined, "done"));
  source.set(item("b", ["ext"]));
  await engine.syncCandidates();
  const b = engine.tasks.bySourceItem("primary", "b")!;
  const deps = await engine.dependencies(b.id);
  assert.equal(deps[0]!.satisfied, true);
  const queued = await engine.transition(b.id, "queued", "test");
  assert.equal(queued.phase, "queued");
});

test("re-sync with an empty relation clears prior dependencies", async () => {
  const { engine, source } = setup();
  source.set(item("a"));
  source.set(item("b", ["a"]));
  await engine.syncCandidates();
  const b = engine.tasks.bySourceItem("primary", "b")!;
  assert.deepEqual(engine.tasks.dependencyItemIds(b.id), ["a"]);

  source.set(item("b", []));
  await engine.syncCandidates();
  assert.deepEqual(engine.tasks.dependencyItemIds(b.id), []);
});

test("setDependencies drops self-references", () => {
  const { engine } = setup();
  const t = engine.tasks.upsertFromItem("primary", item("a", ["a", "b"]));
  assert.deepEqual(engine.tasks.dependencyItemIds(t.id), ["b"]);
});
