import { test } from "node:test";
import assert from "node:assert/strict";
import { isBoardProcess, isServeProcess, paneIdOf, TAB_LABELS, workspaceLabel } from "../src/herdr/bootstrap.ts";

test("the workbench is two named tabs: serve + board (no agent)", () => {
  assert.deepEqual(Object.values(TAB_LABELS).sort(), ["board", "serve"]);
});

test("workspaceLabel namespaces by instance", () => {
  assert.equal(workspaceLabel("fk"), "faktory:fk");
});

test("isBoardProcess recognises a running faktory tui board", () => {
  assert.ok(isBoardProcess("node /repo/node_modules/.bin/tsx /repo/src/cli.ts tui --config fk"));
  assert.ok(!isBoardProcess("-bash"));
  assert.ok(!isBoardProcess("node /repo/src/cli.ts serve --config fk"));
});

test("isServeProcess recognises a running faktory serve", () => {
  assert.ok(isServeProcess("node /repo/src/cli.ts serve fk --no-board"));
  assert.ok(!isServeProcess("node /repo/src/cli.ts tui --config fk"));
});

test("paneIdOf accepts both pane response shapes (pane.split and tab.create)", () => {
  assert.equal(paneIdOf({ pane: { pane_id: "w1:p2" } }), "w1:p2");
  assert.equal(paneIdOf({ pane: { id: "w1:p3" } }), "w1:p3");
  assert.throws(() => paneIdOf({}), /no pane id/);
});
