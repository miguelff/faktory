import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { ensureInstanceDir, instanceRef, listInstances } from "./core/instance.ts";
import { getSecret, openDb, setConfig, setSecret } from "./core/db.ts";
import { createSource } from "./sources/factory.ts";
import { FAKTORY_STATUSES } from "./core/lifecycle.ts";
import {
  FAKTORY_DEPENDS_ON,
  FAKTORY_OWNED_AT,
  FAKTORY_OWNED_BY,
  FAKTORY_STATUS,
} from "./sources/notion.ts";
import type { Invite } from "./core/invite.ts";

/**
 * Terminal setup wizard. Produces one config under ~/.faktory/<slug>/ (its own
 * SQLite state database, secrets included), tagged with the config name.
 * Serve runs it automatically when no config exists; `faktory setup` re-runs
 * it standalone. Everything has a default; Enter accepts it; Ctrl+C aborts
 * safely (nothing half-written until the final confirmation).
 */
const NOTION = "https://api.notion.com/v1";
const B = (s: string) => `\u001b[1m${s}\u001b[22m`;
const DIM = (s: string) => `\u001b[2m${s}\u001b[22m`;
const OK = (s: string) => `\u001b[32m${s}\u001b[39m`;
const ERR = (s: string) => `\u001b[31m${s}\u001b[39m`;

export interface Prompter {
  ask(q: string, def?: string): Promise<string>;
  pick<T>(label: string, items: T[], show: (t: T) => string, defIdx?: number): Promise<T>;
  close(): void;
}

export function createPrompter(): Prompter {
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
      if (items[i] !== undefined) return items[i]!;
      console.log(ERR("  not a valid choice, try again"));
    }
  };
  return { ask, pick, close: () => rl.close() };
}

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

/**
 * Schema for a backlog database Faktory creates itself: title, priority, and
 * the instance-agnostic ownership columns (many instances can share one
 * database; entries are claimed via faktory_owned_by).
 */
export function backlogDatabaseProperties(): Record<string, unknown> {
  return {
    Name: { title: {} },
    [FAKTORY_STATUS]: { select: { options: FAKTORY_STATUSES.map((name) => ({ name })) } },
    [FAKTORY_OWNED_BY]: { rich_text: {} },
    [FAKTORY_OWNED_AT]: { date: {} },
    Priority: { number: { format: "number" } },
  };
}

export function notionOAuthAvailable(): boolean {
  return !!(process.env.FAKTORY_NOTION_CLIENT_ID && process.env.FAKTORY_NOTION_CLIENT_SECRET);
}

/**
 * OAuth against Notion's public-integration flow: open the browser, catch the
 * redirect on a localhost callback, exchange the code for an access token.
 * Requires FAKTORY_NOTION_CLIENT_ID / FAKTORY_NOTION_CLIENT_SECRET.
 */
export async function notionOAuthToken(): Promise<string> {
  const clientId = process.env.FAKTORY_NOTION_CLIENT_ID!;
  const clientSecret = process.env.FAKTORY_NOTION_CLIENT_SECRET!;
  let redirectUri = "";
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        code
          ? "<h3>⚙ faktory is connected to Notion — you can close this tab.</h3>"
          : `<h3>authorization failed: ${error ?? "no code returned"}</h3>`,
      );
      server.close();
      code ? resolve(code) : reject(new Error(`notion oauth failed: ${error ?? "no code returned"}`));
    });
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://localhost:${(server.address() as any).port}/callback`;
      const authUrl =
        `${NOTION}/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
        `&response_type=code&owner=user&redirect_uri=${encodeURIComponent(redirectUri)}`;
      console.log(`\n  Opening the browser to authorize faktory…\n  ${DIM(authUrl)}`);
      if (process.platform === "darwin") execFile("open", [authUrl], () => {});
    });
    setTimeout(() => {
      server.close();
      reject(new Error("notion oauth timed out after 5 minutes"));
    }, 300_000).unref();
  });
  const res = await fetch(`${NOTION}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  const body: any = await res.json();
  if (!res.ok || !body.access_token) throw new Error(body?.error_description ?? body?.error ?? `Notion oauth ${res.status}`);
  return body.access_token as string;
}

async function authenticateNotion(ui: Prompter): Promise<string> {
  const envToken = process.env.NOTION_TOKEN;
  if (notionOAuthAvailable()) {
    const OAUTH = "Sign in with Notion in the browser (OAuth)";
    const PASTE = "Paste an internal integration token";
    const method = await ui.pick("How should faktory authenticate with Notion?", [OAUTH, PASTE], (s) => s);
    if (method === OAUTH) return notionOAuthToken();
  } else {
    console.log(
      DIM("\n  (OAuth needs FAKTORY_NOTION_CLIENT_ID / FAKTORY_NOTION_CLIENT_SECRET — falling back to a token.)"),
    );
  }
  const token = await ui
    .ask("Notion integration token?", envToken ? `${envToken.slice(0, 8)}… (from env)` : undefined)
    .then((t) => (t.endsWith("(from env)") ? envToken! : t));
  if (!token) throw new Error("A Notion token is required (create one at notion.so/my-integrations).");
  return token;
}

interface PickedDatabase {
  id: string;
  title: string;
  /** Set when faktory created the database and therefore knows the schema. */
  created?: boolean;
}

async function pickOrCreateDatabase(ui: Prompter, token: string): Promise<PickedDatabase> {
  console.log(DIM("\n  Looking up databases shared with your integration…"));
  const search = await notion(token, "/search", {
    method: "POST",
    body: JSON.stringify({ filter: { value: "database", property: "object" }, page_size: 25 }),
  });
  const dbs: PickedDatabase[] = (search.results as any[]).map((d) => ({
    id: d.id as string,
    title: (d.title ?? []).map((t: any) => t.plain_text).join("") || "(untitled)",
  }));
  const CREATE: PickedDatabase = { id: "", title: "(create a new backlog database)" };
  const choice = dbs.length
    ? await ui.pick("Which database is the backlog?", [...dbs, CREATE], (d) => (d.id ? `${d.title} ${DIM(d.id)}` : d.title))
    : CREATE;
  if (choice.id) return choice;

  if (!dbs.length) console.log(DIM("  No databases are shared with the integration yet — let's create one."));
  const pages = await notion(token, "/search", {
    method: "POST",
    body: JSON.stringify({ filter: { value: "page", property: "object" }, page_size: 25 }),
  });
  const parents = (pages.results as any[]).map((p) => ({
    id: p.id as string,
    title:
      Object.values<any>(p.properties ?? {})
        .find((prop: any) => prop.type === "title")
        ?.title?.map((t: any) => t.plain_text)
        .join("") || "(untitled page)",
  }));
  if (!parents.length)
    throw new Error("No pages visible to host the database. Share a page with the integration in Notion (••• → Connections).");
  const parent = await ui.pick("Which page should host the new database?", parents, (p) => `${p.title} ${DIM(p.id)}`);
  const title = await ui.ask("Database name?", "Faktory Backlog");
  const created = await notion(token, "/databases", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parent.id },
      title: [{ type: "text", text: { content: title } }],
      properties: backlogDatabaseProperties(),
    }),
  });
  console.log(OK(`  ✔ created database "${title}"`));
  return { id: created.id, title, created: true };
}

export interface SetupOptions {
  /** Config name; prompted for when absent. */
  name?: string;
}

/** Runs the wizard and returns the slug of the saved config. */
export async function runSetup(opts: SetupOptions = {}): Promise<string> {
  const ui = createPrompter();
  try {
    console.log(`\n${B("⚙ faktory setup")} ${DIM("— Enter accepts the default, Ctrl+C aborts")}\n`);

    // 1. Config name → ~/.faktory/<slug>/
    const name = opts.name ?? (await ui.ask("Config name?", "main"));
    const ref = instanceRef(name);
    console.log(DIM(`  → owner id will be ${B(ref.prefix)}, state in ${ref.dir}`));

    // 2. Notion auth (OAuth when client credentials are present) + verification
    const token = await authenticateNotion(ui);
    const me = await notion(token, "/users/me");
    console.log(OK(`  ✔ authenticated as ${me?.name ?? me?.bot?.owner?.type ?? "integration"}`));

    // 3. Backlog database: pick an existing one or create it. Every entry in
    //    it is discoverable; instances claim entries via faktory_owned_by.
    const db = await pickOrCreateDatabase(ui, token);

    // 4. Priority mapping (a created database always has "Priority")
    let priorityProperty: string | undefined = "Priority";
    if (!db.created) {
      const schema = await notion(token, `/databases/${db.id}`);
      const numberProps = Object.entries<any>(schema.properties)
        .filter(([, p]) => p.type === "number")
        .map(([n]) => n);
      priorityProperty = numberProps.length
        ? await ui.pick("Priority property?", [...numberProps, "(none)"], (n) => n, Math.max(0, numberProps.indexOf("Priority")))
        : "(none)";
      if (priorityProperty === "(none)") priorityProperty = undefined;
    }

    // 5. Dispatch defaults
    const repoCwd = await ui.ask("Repository Faktory should dispatch work in?", process.cwd());
    const agentKind = await ui.ask("Agent harness for /kickoff?", "pi");
    const port = await ui.ask("Port for the web board / API?", "4600");

    // 6. Confirm & write
    console.log(`\n  ${B("Summary")}
    config     ${ref.slug} ${DIM(`(owner id ${ref.prefix}, state ${ref.dir})`)}
    database   ${db.title}${db.created ? DIM(" (new)") : ""}
    ownership  ${FAKTORY_STATUS} / ${FAKTORY_OWNED_BY} / ${FAKTORY_OWNED_AT} ${DIM("(added if missing)")}
    depends-on ${FAKTORY_DEPENDS_ON} ${DIM("(relation, added if missing)")}
    priority   ${priorityProperty ?? "(none)"}
    dispatch   ${agentKind} in ${repoCwd}
    board      http://127.0.0.1:${port}\n`);
    if ((await ui.ask("Save? (y/n)", "y")).toLowerCase() !== "y") throw new Error("aborted — nothing saved");

    ensureInstanceDir(ref);
    const dbh = openDb(ref.dbPath);
    setSecret(dbh, "notion.token", token);
    const config = { databaseId: db.id, priorityProperty };
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
    if (source.ensureProperties) {
      const created = await source.ensureProperties();
      if (created.length) console.log(DIM(`  added propert${created.length === 1 ? "y" : "ies"}: ${created.join(", ")}`));
    }
    dbh.close();

    console.log(`\n  ${OK("✔ done.")} ${DIM(`bin/faktory serve ${ref.slug} → http://127.0.0.1:${port}`)}\n`);
    return ref.slug;
  } finally {
    ui.close();
  }
}

export interface JoinOptions {
  /** Config name; prompted for when absent. */
  name?: string;
}

/**
 * Set up a new local config from a collaboration invite. The datasource (kind,
 * config, access secret) comes from the invite; the operator only chooses a
 * name and dispatch defaults. The new config gets its own slug/prefix, so it
 * discovers every entry in the shared datasource and owns only what it claims.
 *
 * Callers must reject invites whose datasource is already configured locally
 * (see datasourceIdentity) before calling this — join is about *new* links.
 */
export async function joinFromInvite(invite: Invite, opts: JoinOptions = {}): Promise<string> {
  if (invite.kind !== "notion") throw new Error(`joining a ${invite.kind} datasource is not supported yet`);
  const cfg = invite.config as { databaseId?: string; priorityProperty?: string; tokenSecret?: string };
  if (!cfg.databaseId) throw new Error("invite is missing its Notion database id");

  const ui = createPrompter();
  try {
    console.log(`\n${B("⚙ faktory join")} ${DIM("— connecting to a shared datasource from an invite; Ctrl+C aborts")}\n`);

    // 1. Config name → ~/.faktory/<slug>/ (own owner id, distinct from the
    //    inviter's). Refuse to reuse an existing config's name: join always
    //    creates a fresh link, never clobbers an existing config's source,
    //    token, or dispatch settings.
    let ref = instanceRef(opts.name ?? (await ui.ask("Config name?", "main")));
    while (listInstances().includes(ref.slug)) {
      console.log(ERR(`  config "${ref.slug}" already exists — choose a different name ${DIM("(Ctrl+C to cancel)")}`));
      if (opts.name) throw new Error(`config "${ref.slug}" already exists — pass a new --config name to join`);
      ref = instanceRef(await ui.ask("Config name?", "main"));
    }
    console.log(DIM(`  → owner id will be ${B(ref.prefix)}, state in ${ref.dir}`));

    // 2. Authenticate against the shared datasource: the invite's secret when
    //    present, otherwise fall back to the normal auth flow.
    const token = invite.secret ?? (await authenticateNotion(ui));
    const me = await notion(token, "/users/me");
    console.log(OK(`  ✔ authenticated as ${me?.name ?? me?.bot?.owner?.type ?? "integration"}`));
    const schema = await notion(token, `/databases/${cfg.databaseId}`);
    const dbTitle = (schema.title ?? []).map((t: any) => t.plain_text).join("") || "(untitled)";
    console.log(OK(`  ✔ reached shared database "${dbTitle}"`));

    // 3. Dispatch defaults (the datasource is fixed by the invite)
    const repoCwd = await ui.ask("Repository Faktory should dispatch work in?", process.cwd());
    const agentKind = await ui.ask("Agent harness for /kickoff?", "pi");
    const port = await ui.ask("Port for the web board / API?", "4600");

    // 4. Confirm & write
    console.log(`\n  ${B("Summary")}
    config     ${ref.slug} ${DIM(`(owner id ${ref.prefix}, state ${ref.dir})`)}
    database   ${dbTitle} ${DIM("(shared via invite)")}
    priority   ${cfg.priorityProperty ?? "(none)"}
    dispatch   ${agentKind} in ${repoCwd}
    board      http://127.0.0.1:${port}\n`);
    if ((await ui.ask("Save? (y/n)", "y")).toLowerCase() !== "y") throw new Error("aborted — nothing saved");

    ensureInstanceDir(ref);
    const dbh = openDb(ref.dbPath);
    // Preserve the invite's full adapter config verbatim (including a custom
    // tokenSecret key if the inviter used one) so the link is a faithful copy
    // of the shared datasource rather than a lossy subset.
    const secretKey = cfg.tokenSecret ?? "notion.token";
    setSecret(dbh, secretKey, token);
    const config = invite.config;
    dbh
      .prepare(
        "INSERT INTO sources (id, kind, config) VALUES ('primary','notion',?) ON CONFLICT(id) DO UPDATE SET kind='notion', config=excluded.config",
      )
      .run(JSON.stringify(config));
    setConfig(dbh, "repoCwd", repoCwd);
    setConfig(dbh, "agentKind", agentKind);
    setConfig(dbh, "port", port);

    const source = createSource(
      { id: "primary", kind: "notion", config },
      { getSecret: (k) => getSecret(dbh, k), prefix: ref.prefix },
    );
    if (source.ensureProperties) {
      const created = await source.ensureProperties();
      if (created.length) console.log(DIM(`  added propert${created.length === 1 ? "y" : "ies"}: ${created.join(", ")}`));
    }
    dbh.close();

    console.log(`\n  ${OK("✔ joined.")} ${DIM(`bin/faktory serve ${ref.slug} → http://127.0.0.1:${port}`)}\n`);
    return ref.slug;
  } finally {
    ui.close();
  }
}
