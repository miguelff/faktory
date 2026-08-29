import { test } from "node:test";
import assert from "node:assert/strict";
import { binExists, harnessDependency, herdrDependency } from "../src/deps.ts";

test("pi installs globally with scripts ignored", () => {
  assert.equal(harnessDependency("pi").installCommand, "npm install -g --ignore-scripts @earendil-works/pi-coding-agent");
});

test("unknown harness kinds have no installer", () => {
  assert.equal(harnessDependency("hermes").installCommand, undefined);
  assert.equal(harnessDependency("hermes").bin, "hermes");
});

test("herdr dependency has a brew/curl installer", () => {
  assert.match(herdrDependency().installCommand!, /brew install herdr/);
});

test("binExists detects present and missing binaries", async () => {
  assert.equal(await binExists("sh"), true);
  assert.equal(await binExists("definitely-not-a-real-binary-xyz"), false);
});
