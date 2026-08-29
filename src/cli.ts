import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureInstanceDir, instanceRef, listInstances } from "./core/instance.ts";
import { getConfig, getSecret, openDb, setConfig, setSecret } from "./core/db.ts";
import { Engine } from "./core/engine.ts";
import { createSource } from "./sources/factory.ts";
import { createApiServer } from "./api/server.ts";
import { HerdrClient } from "./herdr/client.ts";
import type { Phase } from "./core/types.ts";
import { Tui } from "./tui/tui.ts";
import { createPrompter, joinFromInvite, runSetup } from "./setup.ts";
import { datasourceIdentity, decodeInvite, encodeInvite } from "./core/invite.ts";
import { findConfigLinkingDatasource } from "./collab.ts";
import { bootstrapDetached, bootstrapWorkbench } from "./herdr/bootstrap.ts";
import { attachSession, ensureSession, sessionClient, sessionSocketPath, waitForSession } from "./herdr/session.ts";
import { spawn } from "node:child_process";
import { ensureDependencies, harnessDependency, herdrDependency } from "./deps.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKTORY_BIN = join(REPO_ROOT, "bin", "faktory");

/**
 * faktory [config-name]                       — setup (if needed) + serve, the whole product
 * faktory <command> [--config NAME] [...]     (--instance is a deprecated alias)
 *
 * A *config* is one named orchestration under ~/.faktory/<slug>/ with its own
 * SQLite state database, secrets, port, and tag prefix (faktory-<slug>).
 *
 *   serve [config]         the single command that makes Faktory ready:
 *                          no config → terminal setup wizard (Notion OAuth or
 *                          token, pick or create the backlog database);
 *                          several configs → pick one or start a new one; then
 *                          checks/installs external dependencies (herdr +
 *                          harnesses), starts API + web UI, spawns/attaches
 *                          the dedicated herdr session (new terminal window
 *                          when outside herdr), TUI pane, and the orchestrator
 *                          agent loop
 *                          (--headless / --no-tui / --no-agent / --session NAME)
 *   setup                  run the wizard standalone (reconfigure without serving)
 *   instances              list configs
 *   source:set-notion      configure the Notion source non-interactively
 *                          (creates the config if it doesn't exist yet)
 *   sync                   pull candidates into the task table
 *   tasks [--phase P]      list tasks
 *   transition <id> <to>   move a task through the lifecycle
 *   orchestrate            (re)start the orchestrator agent loop against a running serve
 *   tui                    inspect / repair state in the terminal
 *   config:set <k> <v>     persist config values (repoCwd, agentKind, orchestratorKind, port, herdrSession)
 *   config:get [k]         show config values
 *   invite [config]        print a shareable string modelling this config's datasource
 *   join <string>          set up a new config linked to a shared datasource (bails on duplicates)
 */
const HELP = `usage: faktory [config-name]        set up (first run if needed) and start everything
       faktory <command> [options]  advanced: serve|setup|instances|source:set-notion|sync|tasks|transition|orchestrate|tui|config:set|config:get|invite|join|help`;

function requireInstance(name: string | undefined) {
  const instances = listInstances();
  const slug = name ?? (instances.length === 1 ? instances[0] : undefined);
  if (!slug) throw new Error(`--config required (available: ${instances.join(", ") || "none — run faktory serve to set one up"})`);
  const ref = instanceRef(slug);
  const db = openDb(ref.dbPath);
  return { ref, db };
}

/**
 * Resolve which config serve should run: the requested one (setup runs when it
 * doesn't exist yet), the only one, or a terminal pick among the existing
 * configs plus "start a new one". No configs at all → the setup wizard.
 */
async function resolveServeConfig(requested: string | undefined): Promise<string> {
  const configs = listInstances();
  if (requested) {
    const slug = instanceRef(requested).slug;
    if (configs.includes(slug)) return slug;
    console.log(`config "${slug}" does not exist yet — starting setup`);
    return runSetup({ name: requested });
  }
  if (configs.length === 0) return runSetup();
  if (configs.length === 1) return configs[0]!;
  const NEW = "(start a new config)";
  const ui = createPrompter();
  let choice: string;
  try {
    choice = await ui.pick("Which config?", [...configs, NEW], (s) => s);
  } finally {
    ui.close();
  }
  return choice === NEW ? runSetup() : choice;
}

/**
 * Resolve which existing config a command targets: the requested one, the only
 * one, or a terminal pick among the existing configs. Unlike serve, there is
 * no "start a new one" option — the config must already exist.
 */
async function resolveExistingConfig(requested: string | undefined): Promise<string> {
  const configs = listInstances();
  if (requested) {
    const slug = instanceRef(requested).slug;
    if (!configs.includes(slug)) throw new Error(`config "${slug}" does not exist (available: ${configs.join(", ") || "none"})`);
    return slug;
  }
  if (configs.length === 0) throw new Error("no configs yet — run faktory serve to set one up");
  if (configs.length === 1) return configs[0]!;
  const ui = createPrompter();
  try {
    return await ui.pick("Which config?", configs, (s) => s);
  } finally {
    ui.close();
  }
}

function hasSource(ctx: ReturnType<typeof requireInstance>): boolean {
  return !!ctx.db.prepare("SELECT 1 FROM sources LIMIT 1").get();
}

/**
 * One herdr session per config, isolated from every other config's session
 * (own server, socket, workspaces, worktrees). `herdrSession` config overrides.
 */
function sessionNameFor(slug: string): string {
  return `faktory-${slug}`;
}

/** Detached workbench: serve, tui, and the agent loop each in their own pane. */
function detachedWorkbench(slug: string, port: number, orchestratorKind: string) {
  return {
    instance: slug,
    prefix: instanceRef(slug).prefix,
    port,
    repoCwd: REPO_ROOT,
    faktoryBin: FAKTORY_BIN,
    agentKind: orchestratorKind,
    tui: true,
    agent: true,
    serveCommand: `${FAKTORY_BIN} serve ${slug} --no-tui --no-agent --port ${port}`,
  };
}

/**
 * Launcher mode: make sure the workbench runs INSIDE the session (serve pane,
 * TUI pane, agent-loop pane), then attach the current terminal to it. When the
 * session server isn't up yet, attaching starts it and a detached provisioner
 * sets the panes up as soon as the socket answers.
 */
async function launchAndAttach(slug: string, sessionName: string, port: number, orchestratorKind: string): Promise<void> {
  const client = await sessionClient(sessionName);
  if (client) {
    process.env.HERDR_SOCKET_PATH = sessionSocketPath(sessionName);
    const result = await bootstrapDetached(client, detachedWorkbench(slug, port, orchestratorKind));
    if (result.servePaneId) console.log(`serve pane ${result.servePaneId}`);
    if (result.agentName && !result.agentAlreadyRunning) console.log(`orchestrator ${result.agentName} starting`);
  } else {
    spawn(FAKTORY_BIN, ["__provision", slug, "--session", sessionName, "--port", String(port)], {
      detached: true,
      stdio: "ignore",
    }).unref();
    console.log(`starting herdr session "${sessionName}" — the workbench provisions itself once it's up`);
  }
  console.log(`attaching to herdr session "${sessionName}" — board on http://127.0.0.1:${port}`);
  attachSession(sessionName);
}

function buildEngine(ctx: ReturnType<typeof requireInstance>) {
  const { ref, db } = ctx;
  const sourceRow = db.prepare("SELECT * FROM sources LIMIT 1").get() as any;
  if (!sourceRow) throw new Error("no source configured — run faktory source:set-notion");
  const source = createSource(
    { id: sourceRow.id, kind: sourceRow.kind, config: JSON.parse(sourceRow.config) },
    { getSecret: (k) => getSecret(db, k), prefix: ref.prefix },
  );
  return new Engine(db, source, { prefix: ref.prefix });
}

const COMMANDS = new Set([
  "setup",
  "instances",
  "source:set-notion",
  "sync",
  "tasks",
  "transition",
  "serve",
  "orchestrate",
  "tui",
  "config:set",
  "config:get",
  "invite",
  "join",
  "help",
  "__provision",
]);

async function main() {
  const argv = process.argv.slice(2);
  let [cmd, ...rest] = argv;
  // `faktory [config-name] [flags]` is the whole product: setup when needed,
  // then serve. Subcommands are the advanced surface.
  if (cmd === undefined || cmd.startsWith("-") || !COMMANDS.has(cmd)) {
    cmd = "serve";
    rest = argv;
  }
  const { values: flags, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      instance: { type: "string", short: "i" }, // deprecated alias of --config
      phase: { type: "string" },
      port: { type: "string" },
      database: { type: "string" },
      "priority-property": { type: "string" },
      token: { type: "string" },
      "agent-kind": { type: "string" },
      "repo-cwd": { type: "string" },
      actor: { type: "string" },
      note: { type: "string" },
      force: { type: "boolean" },
      headless: { type: "boolean" },
      session: { type: "string" },
      "no-tui": { type: "boolean" },
      "no-agent": { type: "boolean" },
    },
  });

  switch (cmd) {
    case "setup": {
      await runSetup();
      break;
    }
    case "instances": {
      for (const slug of listInstances()) console.log(slug);
      break;
    }
    case "source:set-notion": {
      const name = flags.config ?? flags.instance;
      if (!name) throw new Error("--config <name> is required");
      const ref = ensureInstanceDir(instanceRef(name));
      const db = openDb(ref.dbPath);
      const databaseId = flags.database;
      if (!databaseId) throw new Error("--database <id> is required");
      const token = flags.token ?? process.env.NOTION_TOKEN;
      if (token) setSecret(db, "notion.token", token);
      const config = {
        databaseId,
        priorityProperty: flags["priority-property"],
      };
      db.prepare(
        "INSERT INTO sources (id, kind, config) VALUES ('primary', 'notion', ?) ON CONFLICT(id) DO UPDATE SET kind='notion', config=excluded.config",
      ).run(JSON.stringify(config));
      console.log(`notion source configured: db ${databaseId}, owner id ${ref.prefix}`);
      // Add the faktory_* ownership properties to the database if missing.
      const source = createSource(
        { id: "primary", kind: "notion", config: config as unknown as Record<string, unknown> },
        { getSecret: (k) => getSecret(db, k), prefix: ref.prefix },
      );
      if (source.ensureProperties) {
        const created = await source.ensureProperties();
        if (created.length) console.log(`added ownership propert${created.length === 1 ? "y" : "ies"}: ${created.join(", ")}`);
      }
      break;
    }
    case "sync": {
      const ctx = requireInstance(flags.config ?? flags.instance);
      const fresh = await buildEngine(ctx).syncCandidates();
      console.log(`${fresh.length} new task(s) discovered`);
      for (const t of fresh) console.log(`  #${t.id} ${t.title}`);
      break;
    }
    case "tasks": {
      const ctx = requireInstance(flags.config ?? flags.instance);
      const engine = buildEngine(ctx);
      for (const t of engine.tasks.list(flags.phase as Phase | undefined)) {
        console.log(`#${t.id}\t${t.phase}\t${t.title}\t${t.agentName ?? ""}`);
      }
      break;
    }
    case "transition": {
      const ctx = requireInstance(flags.config ?? flags.instance);
      const engine = buildEngine(ctx);
      const [idRaw, to] = positionals;
      if (!idRaw || !to) throw new Error("usage: faktory transition <id> <phase>");
      const task = flags.force
        ? engine.tasks.transition(Number(idRaw), to as Phase, flags.actor ?? "cli", { force: true, note: flags.note })
        : await engine.transition(Number(idRaw), to as Phase, flags.actor ?? "cli", flags.note);
      console.log(`#${task.id} → ${task.phase}`);
      break;
    }
    case "serve": {
      const slug = await resolveServeConfig(positionals[0] ?? flags.config ?? flags.instance);
      let ctx = requireInstance(slug);
      if (!hasSource(ctx)) {
        console.log(`config "${slug}" has no source yet — finishing setup`);
        ctx.db.close();
        await runSetup({ name: slug });
        ctx = requireInstance(slug);
      }
      const agentKind = flags["agent-kind"] ?? getConfig(ctx.db, "agentKind") ?? "pi";
      const orchestratorKind = getConfig(ctx.db, "orchestratorKind") ?? agentKind;
      const port = Number(flags.port ?? getConfig(ctx.db, "port") ?? 4600);

      // serve is the single readiness gate: every external tool the workbench
      // needs (herdr, task harness, orchestrator harness) is checked and
      // installed here, never by the individual components it bootstraps.
      if (!flags.headless) {
        await ensureDependencies([
          herdrDependency(),
          harnessDependency(agentKind),
          harnessDependency(orchestratorKind),
        ]);
      }

      // Faktory owns herdr. From a plain terminal, serve itself moves into a
      // pane inside the dedicated session (so it survives window closes) and
      // THIS terminal attaches to the session as the herdr client.
      const insidePane = !!(process.env.HERDR_PANE_ID && process.env.HERDR_SOCKET_PATH);
      if (!insidePane && !flags.headless) {
        const sessionName = flags.session ?? getConfig(ctx.db, "herdrSession") ?? sessionNameFor(slug);
        ctx.db.close();
        await launchAndAttach(slug, sessionName, port, orchestratorKind);
        break;
      }

      const engine = buildEngine(ctx);
      let herdr: HerdrClient | undefined;
      try {
        herdr = HerdrClient.fromEnv();
      } catch {
        console.warn("warning: no herdr session — dispatch disabled");
      }
      const server = createApiServer({
        engine,
        prefix: ctx.ref.prefix,
        herdr,
        dispatchDefaults: {
          agentKind,
          repoCwd: flags["repo-cwd"] ?? getConfig(ctx.db, "repoCwd") ?? undefined,
        },
      });
      server.listen(port, "127.0.0.1", async () => {
        console.log(`faktory ${ctx.ref.prefix} on http://127.0.0.1:${port}`);
        const fromPaneId = process.env.HERDR_PANE_ID;
        if (flags.headless || !herdr || !fromPaneId) return;
        try {
          const result = await bootstrapWorkbench(herdr, {
            instance: ctx.ref.slug,
            prefix: ctx.ref.prefix,
            port,
            repoCwd: REPO_ROOT,
            faktoryBin: FAKTORY_BIN,
            agentKind: orchestratorKind,
            fromPaneId,
            tui: !flags["no-tui"],
            agent: !flags["no-agent"],
          });
          if (result.alreadyBootstrapped)
            console.log(`workspace ${result.workspaceId} already bootstrapped — panes preserved`);
          if (result.tuiPaneId) console.log(`tui pane ${result.tuiPaneId}`);
          if (result.agentName)
            console.log(
              result.agentAlreadyRunning
                ? `orchestrator ${result.agentName} already running`
                : `orchestrator ${result.agentName} (${orchestratorKind}) started in pane ${result.agentPaneId}`,
            );
        } catch (e) {
          console.warn(`warning: workbench bootstrap failed: ${(e as Error).message}`);
        }
      });
      break;
    }
    // Internal: pane setup for a cold-started session, run detached by launchAndAttach.
    case "__provision": {
      const slug = positionals[0];
      if (!slug) throw new Error("usage: faktory __provision <config> [--session NAME] [--port N]");
      const sessionName = flags.session ?? sessionNameFor(slug);
      const client = await waitForSession(sessionName);
      process.env.HERDR_SOCKET_PATH = sessionSocketPath(sessionName);
      const { db } = requireInstance(slug);
      const port = Number(flags.port ?? getConfig(db, "port") ?? 4600);
      const agentKind = getConfig(db, "agentKind") ?? "pi";
      const orchestratorKind = getConfig(db, "orchestratorKind") ?? agentKind;
      db.close();
      await bootstrapDetached(client, detachedWorkbench(slug, port, orchestratorKind));
      break;
    }
    case "orchestrate": {
      const ctx = requireInstance(flags.config ?? flags.instance);
      if (!process.env.HERDR_SOCKET_PATH) {
        const sessionName = flags.session ?? getConfig(ctx.db, "herdrSession") ?? sessionNameFor(ctx.ref.slug);
        const { socketPath } = await ensureSession(sessionName, REPO_ROOT);
        process.env.HERDR_SOCKET_PATH = socketPath;
      }
      const herdr = HerdrClient.fromEnv();
      const fromPaneId = process.env.HERDR_PANE_ID;
      const port = Number(flags.port ?? getConfig(ctx.db, "port") ?? 4600);
      const orchestratorKind =
        flags["agent-kind"] ?? getConfig(ctx.db, "orchestratorKind") ?? getConfig(ctx.db, "agentKind") ?? "pi";
      const workbench = {
        instance: ctx.ref.slug,
        prefix: ctx.ref.prefix,
        port,
        repoCwd: REPO_ROOT,
        faktoryBin: FAKTORY_BIN,
        agentKind: orchestratorKind,
        tui: false,
        agent: true,
      };
      const result = fromPaneId
        ? await bootstrapWorkbench(herdr, { ...workbench, fromPaneId })
        : await bootstrapDetached(herdr, workbench);
      console.log(
        result.agentAlreadyRunning
          ? `orchestrator ${result.agentName} already running`
          : `orchestrator ${result.agentName} (${orchestratorKind}) started in pane ${result.agentPaneId} against http://127.0.0.1:${port}`,
      );
      break;
    }
    case "config:set": {
      const { db } = requireInstance(flags.config ?? flags.instance);
      const [key, value] = positionals;
      if (!key || value === undefined) throw new Error("usage: faktory config:set <key> <value>");
      setConfig(db, key, value);
      console.log(`${key} = ${value}`);
      break;
    }
    case "config:get": {
      const { db } = requireInstance(flags.config ?? flags.instance);
      const key = positionals[0];
      if (key) console.log(getConfig(db, key) ?? "");
      else
        for (const row of db.prepare("SELECT key, value FROM config ORDER BY key").all() as any[])
          console.log(`${row.key} = ${row.value}`);
      break;
    }
    case "tui": {
      const ctx = requireInstance(flags.config ?? flags.instance);
      new Tui(buildEngine(ctx), ctx.ref.prefix).start();
      break;
    }
    // Collaboration: share the datasource one config points at (invite), or
    // set up a new local config linked to a shared datasource (join).
    case "invite": {
      const slug = await resolveExistingConfig(positionals[0] ?? flags.config ?? flags.instance);
      const { ref, db } = requireInstance(slug);
      const sourceRow = db.prepare("SELECT id, kind, config FROM sources LIMIT 1").get() as
        | { id: string; kind: string; config: string }
        | undefined;
      if (!sourceRow) throw new Error(`config "${ref.slug}" has no source to share — run faktory setup first`);
      const config = JSON.parse(sourceRow.config) as Record<string, unknown>;
      const secretKey = (config.tokenSecret as string | undefined) ?? "notion.token";
      const secret = getSecret(db, secretKey) ?? undefined;
      const invite = encodeInvite({ v: 1, kind: sourceRow.kind, config, secret });
      console.error(
        `invite for config "${ref.slug}" (datasource ${datasourceIdentity(sourceRow.kind, config)}).\n` +
          (secret ? "⚠ this string embeds an access token — share it over a trusted channel, never commit it.\n" : "") +
          "the recipient runs: faktory join <string>\n",
      );
      console.log(invite);
      break;
    }
    case "join": {
      const str = positionals[0];
      if (!str) throw new Error("usage: faktory join <invite-string>");
      const invite = decodeInvite(str);
      const identity = datasourceIdentity(invite.kind, invite.config);
      const existing = findConfigLinkingDatasource(identity);
      if (existing) throw new Error(`config "${existing}" already links this datasource (${identity}) — nothing to join`);
      const joined = await joinFromInvite(invite, { name: flags.config ?? flags.instance });
      console.log(joined);
      break;
    }
    case "help":
      console.log(HELP);
      break;
    default:
      throw new Error(`unknown command ${cmd}\n${HELP}`);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
