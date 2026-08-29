import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { detachedWorkbench } from "../src/cli/context.ts";
import { isServeProcess } from "../src/herdr/bootstrap.ts";
import { ensureInstanceDir, instanceRef } from "../src/core/instance.ts";
import { openDb } from "../src/core/db.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(REPO_ROOT, "bin", "faktory");

/** Run `bin/faktory <args>` with an isolated FAKTORY_HOME. */
async function faktory(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "fk-cli-"));
  try {
    const { stdout, stderr } = await execFileAsync(BIN, args, { env: { ...process.env, FAKTORY_HOME: home } });
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// The registry is the spec: every user-facing top-level command must be
// discoverable from bare `faktory`. Update this list when you add one.
const TOP_LEVEL = ["serve", "setup", "config", "source", "sync", "tasks", "transition", "tui", "orchestrate", "invite", "join"];

test("no arguments prints subcommands and options on stdout, exit 0", async () => {
  const res = await faktory([]);
  assert.equal(res.code, 0);
  assert.equal(res.stderr, "");
  assert.match(res.stdout, /Usage: faktory/);
  assert.match(res.stdout, /Commands:/);
  for (const cmd of TOP_LEVEL) assert.match(res.stdout, new RegExp(`\\b${cmd}\\b`), `help should list "${cmd}"`);
});

test("--help matches the no-args listing", async () => {
  const help = await faktory(["--help"]);
  assert.equal(help.code, 0);
  for (const cmd of TOP_LEVEL) assert.match(help.stdout, new RegExp(`\\b${cmd}\\b`));
});

test("help hides internal and deprecated commands", async () => {
  const res = await faktory(["--help"]);
  assert.doesNotMatch(res.stdout, /__provision/);
  assert.doesNotMatch(res.stdout, /\binstances\b/);
});

test("unknown command fails with a helpful error", async () => {
  const res = await faktory(["frobnicate"]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /unknown command 'frobnicate'/);
});

test("per-command help documents options non-interactively", async () => {
  const res = await faktory(["transition", "--help"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /<id> <phase>/);
  assert.match(res.stdout, /--force/);
  assert.match(res.stdout, /-c, --config/);
});

test("config groups CRUD and settings under one verb space", async () => {
  const res = await faktory(["config", "--help"]);
  assert.equal(res.code, 0);
  for (const verb of ["list", "create", "delete", "get", "set"]) assert.match(res.stdout, new RegExp(`\\b${verb}\\b`));
});

test("source set-notion requires --database", async () => {
  const res = await faktory(["source", "set-notion", "--config", "x"]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--database/);
});

test("deprecated instances alias still works (hidden)", async () => {
  const res = await faktory(["instances"]);
  assert.equal(res.code, 0); // no configs seeded → empty output, but the command exists
});

test("unknown config subcommand errors clearly instead of a stray-arg message", async () => {
  const res = await faktory(["config", "bogus"]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /unknown command 'bogus'/);
  assert.doesNotMatch(res.stderr, /too many arguments/);
});

test("the internal serve bootstrap string herdr detection relies on is preserved", () => {
  // herdr runs this bin string, which execs src/cli.ts; the resolved process is
  // what isServeProcess/isTuiProcess match on. Pin both the wording and that the
  // resolved form is still recognised — a stray change would silently break
  // session bootstrap with no other failing test.
  const { serveCommand } = detachedWorkbench("omnia", 4600, "pi");
  assert.match(serveCommand, /\bserve omnia --no-tui --no-agent --port 4600$/);
  const resolved = `node /repo/node_modules/.bin/tsx /repo/src/cli.ts ${serveCommand.split("faktory ")[1]}`;
  assert.ok(isServeProcess(resolved), "resolved serve command must be recognised by isServeProcess");
});

test("--instance is a working deprecated alias of --config", async () => {
  const home = mkdtempSync(join(tmpdir(), "fk-cli-"));
  try {
    process.env.FAKTORY_HOME = home;
    const ref = instanceRef("Alpha");
    openDb(ensureInstanceDir(ref).dbPath).close();
    delete process.env.FAKTORY_HOME;

    // `config get` on a config selected via the deprecated alias must resolve it
    // (an unresolved config would exit 1 with "config required").
    const { stdout, stderr } = await execFileAsync(BIN, ["config", "get", "--instance", "Alpha"], {
      env: { ...process.env, FAKTORY_HOME: home },
    });
    assert.equal(stderr, "");
    assert.doesNotMatch(stdout, /config required/);
  } finally {
    delete process.env.FAKTORY_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a nonexistent --config fails with guidance, not a raw db error", async () => {
  const res = await faktory(["tasks", "--config", "ghost"]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /config "ghost" does not exist/);
  assert.doesNotMatch(res.stderr, /unable to open database/);
});
