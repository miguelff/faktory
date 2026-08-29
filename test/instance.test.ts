import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstanceDir, instanceRef, listInstances, slugify } from "../src/core/instance.ts";
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
