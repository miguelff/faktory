import { test } from "node:test";
import assert from "node:assert/strict";
import { isTuiProcess, orchestratorAgentName, orchestratorPrompt, paneIdOf } from "../src/herdr/bootstrap.ts";

test("orchestrator agent name derives from the instance prefix", () => {
  assert.equal(orchestratorAgentName("faktory-fk"), "faktory-fk-orchestrator");
});

test("orchestrator prompt is harness-agnostic and points at skill + API", () => {
  const prompt = orchestratorPrompt({ instance: "fk", prefix: "faktory-fk", port: 4601 });
  assert.match(prompt, /skills\/faktory-orchestrator\/SKILL\.md/);
  assert.match(prompt, /http:\/\/127\.0\.0\.1:4601/);
  assert.match(prompt, /state machine/);
  assert.doesNotMatch(prompt, /\bpi\b/, "prompt must not hardcode a harness");
});

test("isTuiProcess recognises a running faktory tui", () => {
  assert.ok(isTuiProcess("node /repo/node_modules/.bin/tsx /repo/src/cli.ts tui --instance fk"));
  assert.ok(!isTuiProcess("-bash"));
  assert.ok(!isTuiProcess("node /repo/src/cli.ts serve --instance fk"));
});

test("paneIdOf accepts both pane.split response shapes", () => {
  assert.equal(paneIdOf({ pane: { pane_id: "w1:p2" } }), "w1:p2");
  assert.equal(paneIdOf({ pane: { id: "w1:p3" } }), "w1:p3");
  assert.throws(() => paneIdOf({}), /no pane id/);
});
