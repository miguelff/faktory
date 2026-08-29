import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstanceDir, instanceRef } from "../src/core/instance.ts";
import { openDb } from "../src/core/db.ts";
import { findConfigLinkingDatasource } from "../src/collab.ts";
import { datasourceIdentity } from "../src/core/invite.ts";

/** Create a config under FAKTORY_HOME with a notion source pointing at dbId. */
function seedConfig(name: string, dbId: string, extra: Record<string, unknown> = {}): void {
  const ref = ensureInstanceDir(instanceRef(name));
  const db = openDb(ref.dbPath);
  db.prepare("INSERT INTO sources (id, kind, config) VALUES ('primary','notion',?)").run(
    JSON.stringify({ databaseId: dbId, ...extra }),
  );
  db.close();
}

function withHome(fn: () => void): void {
  const home = mkdtempSync(join(tmpdir(), "fk-collab-"));
  process.env.FAKTORY_HOME = home;
  try {
    fn();
  } finally {
    delete process.env.FAKTORY_HOME;
    rmSync(home, { recursive: true, force: true });
  }
}

test("findConfigLinkingDatasource returns null when no config links the datasource", () => {
  withHome(() => {
    seedConfig("alpha", "db-aaa");
    assert.equal(findConfigLinkingDatasource(datasourceIdentity("notion", { databaseId: "db-bbb" })), null);
  });
});

test("findConfigLinkingDatasource finds the config linking a shared datasource", () => {
  withHome(() => {
    seedConfig("alpha", "db-aaa");
    seedConfig("beta", "db-bbb");
    assert.equal(findConfigLinkingDatasource(datasourceIdentity("notion", { databaseId: "db-bbb" })), "beta");
  });
});

test("duplicate detection matches across Notion id formatting and extra config keys", () => {
  withHome(() => {
    // stored dashed + priority mapping; invite bare id without the mapping
    seedConfig("alpha", "3cb433c3-9871-8103-8cf4-e28b4ce327ad", { priorityProperty: "Priority" });
    const inviteIdentity = datasourceIdentity("notion", { databaseId: "3cb433c3987181038cf4e28b4ce327ad" });
    assert.equal(findConfigLinkingDatasource(inviteIdentity), "alpha");
  });
});
