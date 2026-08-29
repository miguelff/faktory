/**
 * One-off Notion database introspection.
 *
 *   NOTION_TOKEN=ntn_xxx tsx scripts/introspect-notion.ts [databaseId]
 *
 * Prints every property, its type, and select/status options + a couple of
 * sample rows, so we can lock Faktory's candidacy / status / tag conventions
 * to the real database. Requires the DB to be shared with the integration.
 */
const DEFAULT_DB = "328433c3-9871-805d-ace6-eae8987ce6c3";
const NOTION_VERSION = "2022-06-28";

function dashify(id: string): string {
  const h = id.replace(/-/g, "");
  return h.length === 32
    ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    : id;
}

async function notion(path: string, init?: RequestInit) {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("Set NOTION_TOKEN (internal integration secret).");
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Notion ${res.status}: ${JSON.stringify(body)}`);
  }
  return body as any;
}

async function main() {
  const dbId = dashify(process.argv[2] ?? DEFAULT_DB);
  const db = await notion(`/databases/${dbId}`);
  const title = db.title?.map((t: any) => t.plain_text).join("") || "(untitled)";
  console.log(`\nDatabase: ${title}\nID: ${dbId}\n`);
  console.log("Properties:");
  for (const [name, prop] of Object.entries<any>(db.properties)) {
    let detail = "";
    if (prop.type === "select") detail = " → " + prop.select.options.map((o: any) => o.name).join(", ");
    if (prop.type === "status") detail = " → " + prop.status.options.map((o: any) => o.name).join(", ");
    if (prop.type === "multi_select") detail = " → " + prop.multi_select.options.map((o: any) => o.name).join(", ");
    console.log(`  • ${name.padEnd(24)} [${prop.type}]${detail}`);
  }

  const rows = await notion(`/databases/${dbId}/query`, {
    method: "POST",
    body: JSON.stringify({ page_size: 3 }),
  });
  console.log(`\nSample rows (${rows.results.length}):`);
  for (const page of rows.results) {
    const titleProp = Object.values<any>(page.properties).find((p) => p.type === "title");
    const t = titleProp?.title?.map((x: any) => x.plain_text).join("") || "(no title)";
    console.log(`  - ${t}  ${page.url}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
