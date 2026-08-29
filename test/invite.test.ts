import { test } from "node:test";
import assert from "node:assert/strict";
import { datasourceIdentity, decodeInvite, encodeInvite, type Invite } from "../src/core/invite.ts";

test("encode/decode round-trips kind, config, and secret", () => {
  const invite: Invite = {
    v: 1,
    kind: "notion",
    config: { databaseId: "abc-123", priorityProperty: "Priority" },
    secret: "ntn_secrettoken",
  };
  const str = encodeInvite(invite);
  assert.ok(str.startsWith("fkinv1_"), "carries a versioned, identifiable prefix");
  assert.deepEqual(decodeInvite(str), invite);
});

test("encode/decode works without a secret", () => {
  const invite: Invite = { v: 1, kind: "notion", config: { databaseId: "abc" } };
  const decoded = decodeInvite(encodeInvite(invite));
  assert.equal(decoded.secret, undefined);
  assert.equal(decoded.config.databaseId, "abc");
});

test("invite strings are URL-/shell-safe (base64url charset)", () => {
  const str = encodeInvite({ v: 1, kind: "notion", config: { databaseId: "a".repeat(50) }, secret: "s?/+=" });
  assert.match(str, /^fkinv1_[A-Za-z0-9_-]+$/);
});

test("decode rejects non-invite, corrupted, and unsupported inputs", () => {
  assert.throws(() => decodeInvite("hello"), /not a faktory invite/);
  assert.throws(() => decodeInvite("fkinv1_!!!notbase64!!!"), /corrupted|unsupported|missing/);
  const badVersion = "fkinv1_" + Buffer.from(JSON.stringify({ v: 2, kind: "notion", config: {} })).toString("base64url");
  assert.throws(() => decodeInvite(badVersion), /unsupported invite version/);
  const noKind = "fkinv1_" + Buffer.from(JSON.stringify({ v: 1, config: {} })).toString("base64url");
  assert.throws(() => decodeInvite(noKind), /missing a source kind/);
});

test("decode tolerates surrounding whitespace", () => {
  const str = encodeInvite({ v: 1, kind: "notion", config: { databaseId: "abc" } });
  assert.deepEqual(decodeInvite(`\n  ${str}  \n`), decodeInvite(str));
});

test("datasourceIdentity ignores Notion dash/case formatting so duplicates match", () => {
  const dashed = datasourceIdentity("notion", { databaseId: "3CB433C3-9871-8103-8CF4-E28B4CE327AD" });
  const bare = datasourceIdentity("notion", { databaseId: "3cb433c398718103" + "8cf4e28b4ce327ad" });
  assert.equal(dashed, bare);
});

test("datasourceIdentity distinguishes different databases and kinds", () => {
  assert.notEqual(
    datasourceIdentity("notion", { databaseId: "aaa" }),
    datasourceIdentity("notion", { databaseId: "bbb" }),
  );
  assert.notEqual(
    datasourceIdentity("notion", { databaseId: "aaa" }),
    datasourceIdentity("github", { databaseId: "aaa" }),
  );
});

test("datasourceIdentity is stable regardless of config key order for unknown kinds", () => {
  const a = datasourceIdentity("jira", { jql: "x", host: "h" });
  const b = datasourceIdentity("jira", { host: "h", jql: "x" });
  assert.equal(a, b);
});
