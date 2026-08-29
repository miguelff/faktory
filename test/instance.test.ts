import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstanceDir, instanceRef, listInstances, removeInstance, slugify } from "../src/core/instance.ts";
import { openDb } from "../src/core/db.ts";

test("slugify normalizes names", () => {
  assert.equal(slugify("Omnia"), "omnia");
  assert.equal(slugify("My Big Project!"), "my-big-project");
  assert.equal(slugify("Café Nº2"), "cafe-no2");
  assert.throws(() => slugify("!!!"));
});

test("prefix derives from the slug as faktory-<slug>", () => {
  const ref = instanceRef("Omnia West");
  assert.equal(ref.slug, "omnia-west");
  assert.equal(ref.prefix, "faktory-omnia-west");
});

test("instances are discovered from FAKTORY_HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "fk-"));
  process.env.FAKTORY_HOME = home;
  try {
    assert.deepEqual(listInstances(), []);
    const ref = ensureInstanceDir(instanceRef("Alpha"));
    openDb(ref.dbPath).close();
    assert.deepEqual(listInstances(), ["alpha"]);
  } finally {
    delete process.env.FAKTORY_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("removeInstance deletes a config's local state and is safe on unknown names", () => {
  const home = mkdtempSync(join(tmpdir(), "fk-"));
  process.env.FAKTORY_HOME = home;
  try {
    const ref = ensureInstanceDir(instanceRef("Gamma"));
    openDb(ref.dbPath).close();
    assert.deepEqual(listInstances(), ["gamma"]);

    assert.equal(removeInstance("Gamma"), true);
    assert.equal(existsSync(ref.dir), false);
    assert.deepEqual(listInstances(), []);

    // Deleting a config that isn't there reports false rather than throwing.
    assert.equal(removeInstance("Gamma"), false);
  } finally {
    delete process.env.FAKTORY_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
