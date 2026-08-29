import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureInstanceDir, instanceRef } from "../src/core/instance.ts";
import { openDb } from "../src/core/db.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(REPO_ROOT, "bin", "faktory");

/** Run `bin/faktory <args>` with an isolated FAKTORY_HOME. */
async function faktory(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(BIN, args, { env: { ...process.env, FAKTORY_HOME: home } });
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Seed a config directory with a real (empty) state DB, the way listInstances expects. */
function seed(name: string): void {
  const ref = ensureInstanceDir(instanceRef(name));
  openDb(ref.dbPath).close();
}

test("config list reports empty, then lists seeded configs", async () => {
  const home = mkdtempSync(join(tmpdir(), "fk-cli-"));
  try {
    const empty = await faktory(home, ["config", "list"]);
    assert.equal(empty.code, 0);
    assert.match(empty.stdout, /no configs yet/);

    process.env.FAKTORY_HOME = home;
    seed("Alpha");
    seed("Beta");
    delete process.env.FAKTORY_HOME;

    const listed = await faktory(home, ["config", "list"]);
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /^alpha\t/m);
    assert.match(listed.stdout, /^beta\t/m);
    assert.match(listed.stdout, /faktory-alpha/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config delete --force removes the config's state without prompting", async () => {
  const home = mkdtempSync(join(tmpdir(), "fk-cli-"));
  process.env.FAKTORY_HOME = home;
  try {
    seed("Alpha");
    seed("Beta");
    const ref = instanceRef("Alpha");

    const res = await faktory(home, ["config", "delete", "Alpha", "--force"]);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /deleted config "alpha"/);
    assert.equal(existsSync(ref.dir), false);

    const listed = await faktory(home, ["config", "list"]);
    assert.doesNotMatch(listed.stdout, /^alpha\t/m);
    assert.match(listed.stdout, /^beta\t/m);
  } finally {
    delete process.env.FAKTORY_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("config delete on an unknown config fails without touching anything", async () => {
  const home = mkdtempSync(join(tmpdir(), "fk-cli-"));
  process.env.FAKTORY_HOME = home;
  try {
    seed("Alpha");
    const res = await faktory(home, ["config", "delete", "nope", "--force"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /does not exist/);
    assert.equal(existsSync(instanceRef("Alpha").dir), true);
  } finally {
    delete process.env.FAKTORY_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
