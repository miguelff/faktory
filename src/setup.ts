import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { ensureInstanceDir, instanceRef, listInstances } from "./core/instance.ts";
import { getSecret, openDb, setConfig, setSecret } from "./core/db.ts";
import { createSource } from "./sources/factory.ts";
import { FAKTORY_STATUSES } from "./core/lifecycle.ts";
import { FAKTORY_OWNED_AT, FAKTORY_OWNED_BY, FAKTORY_STATUS } from "./sources/notion.ts";
import type { Invite } from "./core/invite.ts";

/**
 * Terminal setup wizard. Produces one config under ~/.faktory/<slug>/ (its own
 * SQLite state database, secrets included), tagged with the config name.
 * Serve runs it automatically when no config exists; `faktory config new`
 * runs it standalone. Everything has a default; Enter accepts it; Ctrl+C aborts
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

interface NotionRef {
  id: string;
  title: string;
}

/**
 * Extract the object id from a pasted Notion link (or a bare id). Handles
 * dashed and undashed ids, page/database links, and peek links (?p=<id> wins —
 * that is the page actually open). Returns the dashed UUID form, or null.
 */
export function notionIdFromLink(input: string): string | null {
  const dash = (hex: string) =>
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const compact = input.trim().replace(/-/g, "");
  const peek = compact.match(/[?&]p=([0-9a-f]{32})\b/i);
  if (peek) return dash(peek[1]!.toLowerCase());
  const path = compact.split("?")[0]!;
  const ids = path.match(/[0-9a-f]{32}/gi);
  return ids?.length ? dash(ids[ids.length - 1]!.toLowerCase()) : null;
}

function databaseTitle(db: any): string {
  return ((db.title ?? []) as any[]).map((t) => t.plain_text).join("") || "(untitled)";
}

function pageTitle(page: any): string {
  return (
    Object.values<any>(page.properties ?? {})
      .find((prop: any) => prop.type === "title")
      ?.title?.map((t: any) => t.plain_text)
      .join("") || "(untitled page)"
  );
}

/** The databases living directly inside a page (child_database blocks). */
async function childDatabases(token: string, pageId: string): Promise<NotionRef[]> {
  const out: NotionRef[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion(token, `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    for (const block of res.results as any[]) {
      if (block.type === "child_database") out.push({ id: block.id, title: block.child_database?.title || "(untitled)" });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

/**
 * Resolve a pasted link to the backlog database. The link may point at the
 * database itself or at the page containing it (then its child databases are
 * listed to pick from). Loops until something resolves; every miss explains
 * the likely cause (not shared with the integration).
 */
async function askForDatabase(ui: Prompter, token: string): Promise<NotionRef> {
  while (true) {
    const link = await ui.ask("Paste the link to the backlog database (or the page containing it):");
    const id = notionIdFromLink(link);
    if (!id) {
      console.log(ERR("  that doesn't look like a Notion link — copy it in Notion via ••• → Copy link"));
      continue;
    }
    try {
      const db = await notion(token, `/databases/${id}`);
      return { id: db.id, title: databaseTitle(db) };
    } catch {
      /* not a database — maybe the page containing one */
    }
    try {
      const dbs = await childDatabases(token, id);
      if (dbs.length === 1) return dbs[0]!;
      if (dbs.length > 1) return await ui.pick("Which database on that page?", dbs, (d) => `${d.title} ${DIM(d.id)}`);
      console.log(ERR("  that page contains no database — paste the database's own link or another page"));
    } catch (err) {
      console.log(ERR(`  cannot reach that link (${(err as Error).message})`));
      console.log(DIM("  Share the page or database with the integration in Notion (••• → Connections), then retry."));
    }
  }
}

/** Resolve a pasted link to an existing page (the new database's host). */
async function askForPage(ui: Prompter, token: string): Promise<NotionRef> {
  while (true) {
    const link = await ui.ask("Paste the link to the host page:");
    const id = notionIdFromLink(link);
    if (!id) {
      console.log(ERR("  that doesn't look like a Notion link — copy it in Notion via ••• → Copy link"));
      continue;
    }
    try {
      const page = await notion(token, `/pages/${id}`);
      return { id: page.id, title: pageTitle(page) };
    } catch (err) {
      console.log(ERR(`  cannot reach that page (${(err as Error).message})`));
      console.log(DIM("  Share the page with the integration in Notion (••• → Connections), then retry."));
    }
  }
}

async function createPrivateParentPage(token: string, title: string): Promise<NotionRef> {
  const created = await notion(token, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "workspace", workspace: true },
      properties: { title: { title: [{ type: "text", text: { content: title } }] } },
    }),
  });
  return { id: created.id, title };
}

async function pickParentPage(ui: Prompter, token: string): Promise<NotionRef> {
  const PRIVATE = "Create a new private page";
  const LINK = "Paste a link to the host page";
  const where = await ui.pick("Where should the new database live?", [PRIVATE, LINK], (s) => s);
  if (where === PRIVATE) {
    const title = await ui.ask("Page name?", "Faktory");
    try {
      const page = await createPrivateParentPage(token, title);
      console.log(OK(`  ✔ created private page "${title}"`));
      return page;
    } catch (err) {
      console.log(ERR(`  could not create a private page (${(err as Error).message})`));
      console.log(DIM("  Internal integrations can't create workspace-level pages — paste a link to an existing page instead."));
    }
  }
  return askForPage(ui, token);
}

async function pickOrCreateDatabase(ui: Prompter, token: string): Promise<PickedDatabase> {
  const LINK = "Paste a link to an existing database (or the page containing it)";
  const CREATE = "Create a new blank database";
  const how = await ui.pick("Which database is the backlog?", [LINK, CREATE], (s) => s);
  if (how === LINK) return askForDatabase(ui, token);

  const parent = await pickParentPage(ui, token);
  const title = await ui.ask("Database name?", "Faktory Backlog");
  const created = await notion(token, "/databases", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parent.id },
      title: [{ type: "text", text: { content: title } }],
      properties: backlogDatabaseProperties(),
    }),
  });
  console.log(OK(`  ✔ created database "${title}" in "${parent.title}"`));
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
    console.log(`\n${B("⚙ faktory config new")} ${DIM("— Enter accepts the default, Ctrl+C aborts")}\n`);

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
      if (created.length) console.log(DIM(`  added ownership propert${created.length === 1 ? "y" : "ies"}: ${created.join(", ")}`));
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
      if (created.length) console.log(DIM(`  added ownership propert${created.length === 1 ? "y" : "ies"}: ${created.join(", ")}`));
    }
    dbh.close();

    console.log(`\n  ${OK("✔ joined.")} ${DIM(`bin/faktory serve ${ref.slug} → http://127.0.0.1:${port}`)}\n`);
    return ref.slug;
  } finally {
    ui.close();
  }
}
