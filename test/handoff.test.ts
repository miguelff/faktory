import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHandoff } from "../src/core/handoff.ts";

/** Unit: the pure handoff marker formatter (escaping, ordering, defaults). */

test("renders from and to first, then data-attributes in insertion order", () => {
  assert.equal(
    renderHandoff({ from: "review", to: "execute", note: "go", data: { agent: "pi", pr: "42" } }),
    '<handoff from="review" to="execute" agent="pi" pr="42">go</handoff>',
  );
});

test("omits absent attributes and empty strings", () => {
  assert.equal(renderHandoff({ note: "hello" }), "<handoff>hello</handoff>");
  assert.equal(renderHandoff({ from: "", to: null, note: "x" }), "<handoff>x</handoff>");
});

test("renders an empty body when there is no note", () => {
  assert.equal(renderHandoff({ to: "blocked" }), '<handoff to="blocked"></handoff>');
});

test("skips null/undefined data values but keeps false and 0", () => {
  assert.equal(
    renderHandoff({ data: { a: null, b: undefined, c: false, d: 0 } }),
    '<handoff c="false" d="0"></handoff>',
  );
});

test("escapes attribute values and body text", () => {
  assert.equal(
    renderHandoff({ to: 'a"<&>', note: "1 < 2 & 3 > 0" }),
    '<handoff to="a&quot;&lt;&amp;&gt;">1 &lt; 2 &amp; 3 &gt; 0</handoff>',
  );
});

test("top-level from/to win over same-named data keys", () => {
  assert.equal(
    renderHandoff({ from: "shape", to: "execute", data: { from: "nope", to: "nope" } }),
    '<handoff from="shape" to="execute"></handoff>',
  );
});

test("rejects invalid data-attribute names", () => {
  assert.throws(() => renderHandoff({ data: { "bad name": "x" } }), /invalid handoff data-attribute name/);
});
