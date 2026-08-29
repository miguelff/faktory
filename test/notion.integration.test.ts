import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSource } from "../src/sources/factory.ts";
import { buildCandidateFilter, pageToWorkItem, type NotionSourceConfig } from "../src/sources/notion.ts";

/**
 * Integration test: the Notion adapter against a fake Notion API server.
 * Exercises pagination, filtering payloads, tag read-modify-write, and status.
 */
const cfg: NotionSourceConfig = {
  databaseId: "db-1",
  candidateProperty: "Tags",
  candidateValue: "faktory-test-execute",
  statusProperty: "Status",
  tagsProperty: "Tags",
  priorityProperty: "Priority",
  excludeStatuses: ["Done", "Discarded"],
};

function page(id: string, tags: string[], status = "New", priority: number | null = null) {
  return {
    id,
    url: `https://notion.so/${id}`,
    last_edited_time: "2026-01-01T00:00:00Z",
    properties: {
      Name: { type: "title", title: [{ plain_text: `Task ${id}` }] },
      Status: { type: "status", status: { name: status } },
      Tags: { type: "multi_select", multi_select: tags.map((name) => ({ name })) },
      Priority: { type: "number", number: priority },
    },
  };
}

let server: Server;
let baseUrl: string;
const state = {
  pages: new Map<string, any>([
    ["p1", page("p1", ["faktory-test-execute"], "New", 5)],
    ["p2", page("p2", ["faktory-test-execute", "misc"], "Build / Do", 1)],
  ]),
  lastQueryFilter: null as unknown,
  patches: [] as Array<{ id: string; body: any }>,
  dbOptions: [{ name: "misc" }, { name: "faktory-test-execute" }] as Array<{ name: string }>,
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
      res.end(
        JSON.stringify({ properties: { Tags: { type: "multi_select", multi_select: { options: state.dbOptions } } } }),
      );
      return;
    }
    if (url === "/databases/db-1" && req.method === "PATCH") {
      state.dbOptions = body.properties.Tags.multi_select.options;
      res.end("{}");
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
        if (body.properties?.Tags) {
          p.properties.Tags.multi_select = body.properties.Tags.multi_select;
        }
        if (body.properties?.Status) {
          p.properties.Status.status = body.properties.Status.status;
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

test("listCandidates paginates and sends the candidacy filter", async () => {
  const source = makeSource();
  const items = await source.listCandidates();
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.title), ["Task p1", "Task p2"]);
  assert.equal(items[0]!.priority, 5);
  const filter = state.lastQueryFilter as any;
  assert.deepEqual(filter.and[0], { property: "Tags", multi_select: { contains: "faktory-test-execute" } });
  assert.deepEqual(filter.and[1], { property: "Status", status: { does_not_equal: "Done" } });
});

test("getItem returns null on 404", async () => {
  const source = makeSource();
  assert.equal(await source.getItem("nope"), null);
  const item = await source.getItem("p1");
  assert.equal(item!.status, "New");
});

test("addTag/removeTag do read-modify-write and are idempotent", async () => {
  const source = makeSource();
  state.patches.length = 0;
  await source.addTag!("p1", "faktory-test-processing");
  await source.addTag!("p1", "faktory-test-processing"); // no-op
  await source.removeTag!("p1", "faktory-test-execute");
  const tags = state.pages.get("p1").properties.Tags.multi_select.map((o: any) => o.name);
  assert.deepEqual(tags, ["faktory-test-processing"]);
  assert.equal(state.patches.length, 2); // second add skipped
});

test("setStatus patches the status property", async () => {
  const source = makeSource();
  await source.setStatus("p2", "Review");
  assert.equal(state.pages.get("p2").properties.Status.status.name, "Review");
});

test("pageToWorkItem tolerates missing properties", () => {
  const item = pageToWorkItem({ id: "x", url: "u", properties: {} }, cfg);
  assert.equal(item.title, "(untitled)");
  assert.equal(item.status, null);
  assert.deepEqual(item.tags, []);
});

test("ensureTags provisions only the missing multi_select options", async () => {
  const source = makeSource();
  const created = await source.ensureTags!(["faktory-test-execute", "faktory-test-processing", "faktory-test-stalled"]);
  assert.deepEqual(created, ["faktory-test-processing", "faktory-test-stalled"]);
  assert.deepEqual(
    state.dbOptions.map((o) => o.name),
    ["misc", "faktory-test-execute", "faktory-test-processing", "faktory-test-stalled"],
  );
  const again = await source.ensureTags!(["faktory-test-processing"]);
  assert.deepEqual(again, [], "idempotent");
});

test("buildCandidateFilter skips status exclusions without a status property", () => {
  const f = buildCandidateFilter({ ...cfg, statusProperty: undefined }) as any;
  assert.equal(f.and.length, 1);
});

test("statusType select switches filter and write shapes", async () => {
  const f = buildCandidateFilter({ ...cfg, statusType: "select" }) as any;
  assert.deepEqual(f.and[1], { property: "Status", select: { does_not_equal: "Done" } });
  const source = createSource(
    { id: "sel", kind: "notion", config: { ...cfg, statusType: "select" } as unknown as Record<string, unknown> },
    { getSecret: () => "tkn", prefix: "faktory-test", baseUrl },
  );
  state.patches.length = 0;
  await source.setStatus("p1", "Review");
  assert.deepEqual(state.patches[0]!.body.properties.Status, { select: { name: "Review" } });
});
