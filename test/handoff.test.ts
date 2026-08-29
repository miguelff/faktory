import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHandoff } from "../src/core/handoff.ts";

/** Unit: the pure handoff marker formatter (escaping, ordering, defaults). */

test("renders agent and status first, then data-attributes in insertion order", () => {
  assert.equal(
    renderHandoff({ agent: "pi", status: "running", note: "go", data: { iteration: 2, pr: "42" } }),
    '<faktory agent="pi" status="running" iteration="2" pr="42">go</faktory>',
  );
});

test("omits absent attributes and empty strings", () => {
  assert.equal(renderHandoff({ note: "hello" }), "<faktory>hello</faktory>");
  assert.equal(renderHandoff({ agent: "", status: null, note: "x" }), "<faktory>x</faktory>");
});

test("renders an empty body when there is no note", () => {
  assert.equal(renderHandoff({ status: "blocked" }), '<faktory status="blocked"></faktory>');
});

test("skips null/undefined data values but keeps false and 0", () => {
  assert.equal(
    renderHandoff({ data: { a: null, b: undefined, c: false, d: 0 } }),
    '<faktory c="false" d="0"></faktory>',
  );
});

test("escapes attribute values and body text", () => {
  assert.equal(
    renderHandoff({ status: 'a"<&>', note: "1 < 2 & 3 > 0" }),
    '<faktory status="a&quot;&lt;&amp;&gt;">1 &lt; 2 &amp; 3 &gt; 0</faktory>',
  );
});

test("top-level agent/status win over same-named data keys", () => {
  assert.equal(
    renderHandoff({ agent: "pi", status: "running", data: { agent: "nope", status: "nope" } }),
    '<faktory agent="pi" status="running"></faktory>',
  );
});

test("rejects invalid data-attribute names", () => {
  assert.throws(() => renderHandoff({ data: { "bad name": "x" } }), /invalid handoff data-attribute name/);
});
