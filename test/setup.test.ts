import { test } from "node:test";
import assert from "node:assert/strict";
import { backlogDatabaseProperties, notionOAuthAvailable } from "../src/setup.ts";
import { DISCOVERABLE } from "../src/core/lifecycle.ts";

test("created backlog database carries title, ownership columns, and priority", () => {
  const props = backlogDatabaseProperties() as any;
  assert.deepEqual(props.Name, { title: {} });
  const statusNames = props.faktory_status.select.options.map((o: any) => o.name);
  assert.ok(statusNames.includes(DISCOVERABLE) && statusNames.includes("done"));
  assert.equal(new Set(statusNames).size, statusNames.length, "status options must be unique");
  assert.ok(props.faktory_owned_by.rich_text);
  assert.ok(props.faktory_owned_at.date);
  assert.ok(props.Priority.number);
});

test("oauth availability requires both client credentials", () => {
  const saved = { id: process.env.FAKTORY_NOTION_CLIENT_ID, secret: process.env.FAKTORY_NOTION_CLIENT_SECRET };
  try {
    delete process.env.FAKTORY_NOTION_CLIENT_ID;
    delete process.env.FAKTORY_NOTION_CLIENT_SECRET;
    assert.equal(notionOAuthAvailable(), false);
    process.env.FAKTORY_NOTION_CLIENT_ID = "cid";
    assert.equal(notionOAuthAvailable(), false);
    process.env.FAKTORY_NOTION_CLIENT_SECRET = "sec";
    assert.equal(notionOAuthAvailable(), true);
  } finally {
    if (saved.id) process.env.FAKTORY_NOTION_CLIENT_ID = saved.id;
    if (saved.secret) process.env.FAKTORY_NOTION_CLIENT_SECRET = saved.secret;
  }
});
