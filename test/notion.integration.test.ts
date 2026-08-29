import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSource } from "../src/sources/factory.ts";
import { buildCandidateFilter, pageToWorkItem, type NotionSourceConfig } from "../src/sources/notion.ts";

/**
 * Integration test: the Notion adapter against a fake Notion API server.
 * Exercises pagination, the ownership candidacy filter, the claim CAS, status
 * mirroring, and ensureProperties schema provisioning.
 */
const cfg: NotionSourceConfig = {
  databaseId: "db-1",
  priorityProperty: "Priority",
};

function page(id: string, ownedBy: string | null = null, status: string | null = null, priority: number | null = null) {
  return {
    id,
    url: `https://notion.so/${id}`,
    last_edited_time: "2026-01-01T00:00:00Z",
    properties: {
      Name: { type: "title", title: [{ plain_text: `Task ${id}` }] },
      faktory_status: { type: "select", select: status ? { name: status } : null },
      faktory_owned_by: { type: "rich_text", rich_text: ownedBy ? [{ plain_text: ownedBy }] : [] },
      faktory_owned_at: { type: "date", date: null },
      Priority: { type: "number", number: priority },
    },
  };
}

let server: Server;
let baseUrl: string;
const state = {
  pages: new Map<string, any>([
    ["p1", page("p1", null, null, 5)],
    ["p2", page("p2", "faktory-test", "running", 1)],
  ]),
  lastQueryFilter: null as unknown,
  patches: [] as Array<{ id: string; body: any }>,
  comments: [] as Array<{ pageId: string; text: string }>,
  dbProperties: { Name: { type: "title" } } as Record<string, any>,
  /** When set, the next owned_by PATCH is overridden — simulates a lost race. */
  raceWinner: null as string | null,
};

before(async () => {
  server = createServer(async (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== "Bearer tkn") {
      res.writeHead(401).end(JSON.stringify({ message: "API token is invalid." }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = req.url!;

    if (url === "/databases/db-1" && req.method === "GET") {
      res.end(JSON.stringify({ properties: state.dbProperties }));
      return;
    }
    if (url === "/databases/db-1" && req.method === "PATCH") {
      Object.assign(state.dbProperties, body.properties);
      res.end("{}");
      return;
    }
    if (req.method === "POST" && url === "/comments") {
      const pageId = body.parent?.page_id;
      const text = (body.rich_text ?? []).map((r: any) => r.text?.content ?? "").join("");
      state.comments.push({ pageId, text });
      res.end(JSON.stringify({ object: "comment", id: "c1", parent: body.parent }));
      return;
    }
    if (req.method === "POST" && url === "/databases/db-1/query") {
      state.lastQueryFilter = body.filter;
      const all = [...state.pages.values()];
      // paginate 1 per page to prove cursor handling
      const start = body.start_cursor ? Number(body.start_cursor) : 0;
      res.end(
        JSON.stringify({
          results: all.slice(start, start + 1),
          has_more: start + 1 < all.length,
          next_cursor: String(start + 1),
        }),
      );
      return;
    }
    const pageMatch = /^\/pages\/(.+)$/.exec(url);
    if (pageMatch) {
      const p = state.pages.get(pageMatch[1]!);
      if (!p) {
        res.writeHead(404).end(JSON.stringify({ message: "not found" }));
        return;
      }
      if (req.method === "PATCH") {
        state.patches.push({ id: pageMatch[1]!, body });
        if (body.properties?.faktory_status) {
          p.properties.faktory_status.select = body.properties.faktory_status.select;
        }
        if (body.properties?.faktory_owned_by) {
          const winner = state.raceWinner ?? body.properties.faktory_owned_by.rich_text[0]?.text?.content;
          state.raceWinner = null;
          p.properties.faktory_owned_by.rich_text = winner ? [{ plain_text: winner }] : [];
        }
        if (body.properties?.faktory_owned_at) {
          p.properties.faktory_owned_at.date = body.properties.faktory_owned_at.date;
        }
      }
      res.end(JSON.stringify(p));
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

function makeSource() {
  return createSource(
    { id: "primary", kind: "notion", config: cfg as unknown as Record<string, unknown> },
    { getSecret: (k) => (k === "notion.token" ? "tkn" : null), prefix: "faktory-test", baseUrl },
  );
}

test("factory rejects unknown kinds", () => {
  assert.throws(
    () => createSource({ id: "x", kind: "jira", config: {} }, { getSecret: () => null, prefix: "p" }),
    /Unknown work source kind/,
  );
});

test("listCandidates paginates and filters to unowned + own entries", async () => {
  const source = makeSource();
  const items = await source.listCandidates();
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.title), ["Task p1", "Task p2"]);
  assert.equal(items[0]!.priority, 5);
  assert.equal(items[0]!.ownedBy, null);
  assert.equal(items[1]!.ownedBy, "faktory-test");
  assert.equal(items[1]!.status, "running");
  const filter = state.lastQueryFilter as any;
  assert.deepEqual(filter.and[0].or, [
    { property: "faktory_owned_by", rich_text: { is_empty: true } },
    { property: "faktory_owned_by", rich_text: { equals: "faktory-test" } },
  ]);
  assert.deepEqual(filter.and[1], { property: "faktory_status", select: { does_not_equal: "done" } });
});

test("listCandidates skips done and archived entries the source still returns", async () => {
  const donePage = page("pd", "faktory-test", "done", 3);
  const archivedPage = { ...page("pa", null, null, 4), archived: true };
  state.pages.set("pd", donePage);
  state.pages.set("pa", archivedPage);
  try {
    const source = makeSource();
    const ids = (await source.listCandidates()).map((i) => i.id);
    assert.ok(!ids.includes("pd"), "done entry is not surfaced");
    assert.ok(!ids.includes("pa"), "archived entry is not surfaced");
  } finally {
    state.pages.delete("pd");
    state.pages.delete("pa");
  }
});

test("getItem returns null on 404", async () => {
  const source = makeSource();
  assert.equal(await source.getItem("nope"), null);
  const item = await source.getItem("p2");
  assert.equal(item!.status, "running");
});

test("claim stamps ownership on an unowned entry (CAS win)", async () => {
  const source = makeSource();
  state.patches.length = 0;
  const owner = await source.claim("p1");
  assert.equal(owner, "faktory-test");
  const props = state.pages.get("p1").properties;
  assert.equal(props.faktory_owned_by.rich_text[0].plain_text, "faktory-test");
  assert.ok(props.faktory_owned_at.date.start, "owned_at stamped");
});

test("claim is idempotent for an entry we already own", async () => {
  const source = makeSource();
  state.patches.length = 0;
  assert.equal(await source.claim("p1"), "faktory-test");
  assert.equal(state.patches.length, 0, "no write when already owned");
});

test("claim reports the winner when the CAS is lost", async () => {
  state.pages.set("p3", page("p3"));
  state.raceWinner = "faktory-rival";
  const source = makeSource();
  assert.equal(await source.claim("p3"), "faktory-rival");
});

test("claim refuses to overwrite an entry owned by another instance", async () => {
  state.pages.set("p4", page("p4", "faktory-rival"));
  const source = makeSource();
  state.patches.length = 0;
  assert.equal(await source.claim("p4"), "faktory-rival");
  assert.equal(state.patches.length, 0, "no write at all");
});

test("setStatus patches faktory_status", async () => {
  const source = makeSource();
  await source.setStatus("p2", "reviewing");
  assert.equal(state.pages.get("p2").properties.faktory_status.select.name, "reviewing");
});

test("comment posts the handoff marker to the page comment thread", async () => {
  const source = makeSource();
  state.comments.length = 0;
  const marker = '<faktory agent="pi" status="running">Plan approved.</faktory>';
  await source.comment("p2", marker);
  assert.deepEqual(state.comments, [{ pageId: "p2", text: marker }]);
});

test("pageToWorkItem tolerates missing properties", () => {
  const item = pageToWorkItem({ id: "x", url: "u", properties: {} }, cfg);
  assert.equal(item.title, "(untitled)");
  assert.equal(item.status, null);
  assert.equal(item.ownedBy, null);
  assert.equal(item.ownedAt, null);
});

test("ensureProperties adds only the missing faktory_* columns", async () => {
  const source = makeSource();
  state.dbProperties = { Name: { type: "title" }, faktory_status: { type: "select" } };
  const created = await source.ensureProperties!();
  assert.deepEqual(created, ["faktory_owned_by", "faktory_owned_at"]);
  assert.ok(state.dbProperties.faktory_owned_by.rich_text);
  assert.ok(state.dbProperties.faktory_owned_at.date);
  const again = await source.ensureProperties!();
  assert.deepEqual(again, [], "idempotent");
});

test("buildCandidateFilter honours custom property names", () => {
  const f = buildCandidateFilter({ ...cfg, ownedByProperty: "owner" }, "faktory-x") as any;
  assert.deepEqual(f.and[0].or[0], { property: "owner", rich_text: { is_empty: true } });
  assert.deepEqual(f.and[0].or[1], { property: "owner", rich_text: { equals: "faktory-x" } });
});

test("buildCandidateFilter excludes finished (done) entries", () => {
  const f = buildCandidateFilter(cfg, "faktory-x") as any;
  assert.deepEqual(f.and[1], { property: "faktory_status", select: { does_not_equal: "done" } });
});
