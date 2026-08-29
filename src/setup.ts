import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ensureInstanceDir, instanceRef } from "./core/instance.ts";
import { getSecret, openDb, setConfig, setSecret } from "./core/db.ts";
import { createSource } from "./sources/factory.ts";
import { tagForRole } from "./core/lifecycle.ts";
import { TAG_ROLES } from "./core/types.ts";

/**
 * `faktory setup` — interactive onboarding for humans.
 * Walks through: instance → Notion token → database picker → candidacy →
 * status/priority mapping → repo & agent defaults. Everything has a default;
 * Enter accepts it. Ctrl+C aborts safely at any point (nothing half-written
 * until the final confirmation).
 */
const NOTION = "https://api.notion.com/v1";
const B = (s: string) => `\u001b[1m${s}\u001b[22m`;
const DIM = (s: string) => `\u001b[2m${s}\u001b[22m`;
const OK = (s: string) => `\u001b[32m${s}\u001b[39m`;
const ERR = (s: string) => `\u001b[31m${s}\u001b[39m`;

async function notion(token: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${NOTION}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(body?.message ?? `Notion ${res.status}`);
  return body;
}

export async function runSetup(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, def?: string): Promise<string> => {
    const a = (await rl.question(`  ${q}${def ? DIM(` (${def})`) : ""} `)).trim();
    return a || def || "";
  };
  const pick = async <T>(label: string, items: T[], show: (t: T) => string, defIdx = 0): Promise<T> => {
    console.log(`\n  ${B(label)}`);
    items.forEach((it, i) => console.log(`    ${i + 1}. ${show(it)}${i === defIdx ? DIM("  ← default") : ""}`));
    while (true) {
      const a = await ask("choose a number", String(defIdx + 1));
      const i = Number(a) - 1;
      if (items[i]) return items[i]!;
      console.log(ERR("  not a valid choice, try again"));
    }
  };

  try {
    console.log(`\n${B("⚙ faktory setup")} ${DIM("— Enter accepts the default, Ctrl+C aborts")}\n`);

    // 1. Instance
    const name = await ask("Instance name?", "main");
    const ref = instanceRef(name);
    console.log(DIM(`  → tag prefix will be ${B(ref.prefix)}, state in ${ref.dir}`));

    // 2. Token
    const envToken = process.env.NOTION_TOKEN;
    const token = await ask("Notion integration token?", envToken ? `${envToken.slice(0, 8)}… (from env)` : undefined).then(
      (t) => (t.endsWith("(from env)") ? envToken! : t),
    );
    if (!token) throw new Error("A Notion token is required (create one at notion.so/my-integrations).");

    // 3. Database picker (searches everything shared with the integration)
    console.log(DIM("\n  Looking up databases shared with your integration…"));
    const search = await notion(token, "/search", {
      method: "POST",
      body: JSON.stringify({ filter: { value: "database", property: "object" }, page_size: 25 }),
    });
    const dbs = (search.results as any[]).map((d) => ({
      id: d.id as string,
      title: (d.title ?? []).map((t: any) => t.plain_text).join("") || "(untitled)",
    }));
    if (!dbs.length) throw new Error("No databases visible. Share one with the integration in Notion (••• → Connections).");
    const db = await pick("Which database is the backlog?", dbs, (d) => `${d.title} ${DIM(d.id)}`);

    // 4. Candidacy: property + value
    const schema = await notion(token, `/databases/${db.id}`);
    const props = Object.entries<any>(schema.properties);
    const multiSelects = props.filter(([, p]) => p.type === "multi_select").map(([n]) => n);
    if (!multiSelects.length) throw new Error("The database has no multi_select property to use for tags.");
    const candidateProperty = await pick(
      "Which property marks candidates (tags live here)?",
      multiSelects,
      (n) => n,
      Math.max(0, multiSelects.indexOf("Tags")),
    );
    const candidateValue = await ask("Tag value that marks an issue as ready for pickup?", `${ref.prefix}-execute`);

    // 5. Status + priority mapping
    const statusProps = props.filter(([, p]) => p.type === "status" || p.type === "select").map(([n]) => n);
    const statusProperty = statusProps.length
      ? await pick("Which property is the human-facing status?", [...statusProps, "(none)"], (n) => n,
          Math.max(0, statusProps.indexOf("Status")))
      : "(none)";
    const numberProps = props.filter(([, p]) => p.type === "number").map(([n]) => n);
    const priorityProperty = numberProps.length
      ? await pick("Priority property?", [...numberProps, "(none)"], (n) => n, Math.max(0, numberProps.indexOf("Priority")))
      : "(none)";

    // 6. Dispatch defaults
    const repoCwd = await ask("Repository Faktory should dispatch work in?", process.cwd());
    const agentKind = await ask("Agent harness for /kickoff?", "pi");
    const port = await ask("Port for the web board / API?", "4600");

    // 7. Confirm & write
    console.log(`\n  ${B("Summary")}
    instance   ${ref.slug} ${DIM(`(prefix ${ref.prefix})`)}
    database   ${db.title}
    candidacy  ${candidateProperty} contains "${candidateValue}"
    status     ${statusProperty}    priority ${priorityProperty}
    dispatch   ${agentKind} in ${repoCwd}
    board      http://127.0.0.1:${port}\n`);
    if ((await ask("Save? (y/n)", "y")).toLowerCase() !== "y") throw new Error("aborted — nothing saved");

    ensureInstanceDir(ref);
    const dbh = openDb(ref.dbPath);
    setSecret(dbh, "notion.token", token);
    const config = {
      databaseId: db.id,
      candidateProperty,
      candidateValue,
      statusProperty: statusProperty === "(none)" ? undefined : statusProperty,
      tagsProperty: candidateProperty,
      priorityProperty: priorityProperty === "(none)" ? undefined : priorityProperty,
    };
    dbh
      .prepare(
        "INSERT INTO sources (id, kind, config) VALUES ('primary','notion',?) ON CONFLICT(id) DO UPDATE SET kind='notion', config=excluded.config",
      )
      .run(JSON.stringify(config));
    setConfig(dbh, "repoCwd", repoCwd);
    setConfig(dbh, "agentKind", agentKind);
    setConfig(dbh, "port", port);

    const source = createSource(
      { id: "primary", kind: "notion", config: config as unknown as Record<string, unknown> },
      { getSecret: (k) => getSecret(dbh, k), prefix: ref.prefix },
    );
    if (source.ensureTags) {
      const created = await source.ensureTags([...new Set([candidateValue, ...TAG_ROLES.map((r) => tagForRole(ref.prefix, r))])]);
      if (created.length) console.log(DIM(`  provisioned tag option(s): ${created.join(", ")}`));
    }

    console.log(`\n  ${OK("✔ done.")} Next:
    bin/faktory serve --instance ${ref.slug}      ${DIM(`→ http://127.0.0.1:${port}`)}
    bin/faktory tui   --instance ${ref.slug}
    Tag an issue with ${B(candidateValue)} in Notion, then press Sync.\n`);
  } finally {
    rl.close();
  }
}
