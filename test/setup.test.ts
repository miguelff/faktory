import { test } from "node:test";
import assert from "node:assert/strict";
import { backlogDatabaseProperties, notionIdFromLink, notionOAuthAvailable } from "../src/setup.ts";
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

test("notionIdFromLink extracts the id from pasted links and bare ids", () => {
  const dashed = "328433c3-9871-805d-ace6-eae8987ce6c3";
  assert.equal(notionIdFromLink("https://www.notion.so/acme/Backlog-328433c39871805dace6eae8987ce6c3"), dashed);
  assert.equal(notionIdFromLink("https://www.notion.so/acme/Backlog-328433c39871805dace6eae8987ce6c3?v=aaaabbbbccccddddeeeeffff00001111"), dashed);
  assert.equal(notionIdFromLink(dashed), dashed);
  assert.equal(notionIdFromLink("328433c39871805dace6eae8987ce6c3"), dashed);
  assert.equal(
    notionIdFromLink("https://www.notion.so/acme/Parent-aaaabbbbccccddddeeeeffff00001111?p=328433c39871805dace6eae8987ce6c3&pm=s"),
    dashed,
    "a peek link resolves to the page actually open",
  );
  assert.equal(
    notionIdFromLink("https://app.notion.com/p/Miguel-s-Private-Area-1de433c3987181b898daf2d859951c7f?source=copy_link"),
    "1de433c3-9871-81b8-98da-f2d859951c7f",
    "a slug ending in hex-looking letters must not shift the id window",
  );
  assert.equal(notionIdFromLink("https://www.notion.so/acme/just-a-page"), null);
  assert.equal(notionIdFromLink("not a link at all"), null);
});
