import { parseArgs } from "node:util";
import { ensureInstanceDir, instanceRef, listInstances } from "./core/instance.ts";
import { getConfig, getSecret, openDb, setConfig, setSecret } from "./core/db.ts";
import { Engine } from "./core/engine.ts";
import { createSource } from "./sources/factory.ts";
import { createApiServer } from "./api/server.ts";
import { HerdrClient } from "./herdr/client.ts";
import type { Phase } from "./core/types.ts";
import { Tui } from "./tui/tui.ts";

/**
 * faktory <command> [--instance NAME] [...]
 *
 *   init <name>            create an instance (tag prefix faktory-<slug>)
 *   instances              list instances
 *   source:set-notion      configure the Notion source for an instance
 *   sync                   pull candidates into the task table
 *   tasks [--phase P]      list tasks
 *   transition <id> <to>   move a task through the lifecycle
 *   serve [--port N]       start API + web UI
 *   tui                    inspect / repair state in the terminal
 */
const HELP = `usage: faktory <init|instances|source:set-notion|sync|tasks|transition|serve|tui> [options]`;

function requireInstance(name: string | undefined) {
  const instances = listInstances();
  const slug = name ?? (instances.length === 1 ? instances[0] : undefined);
  if (!slug) throw new Error(`--instance required (available: ${instances.join(", ") || "none — run faktory init"})`);
  const ref = instanceRef(slug);
  const db = openDb(ref.dbPath);
  return { ref, db };
}

function buildEngine(ctx: ReturnType<typeof requireInstance>) {
  const { ref, db } = ctx;
  const sourceRow = db.prepare("SELECT * FROM sources LIMIT 1").get() as any;
  if (!sourceRow) throw new Error("no source configured — run faktory source:set-notion");
  const source = createSource(
    { id: sourceRow.id, kind: sourceRow.kind, config: JSON.parse(sourceRow.config) },
    { getSecret: (k) => getSecret(db, k), prefix: ref.prefix },
  );
  const statusByPhase = JSON.parse(getConfig(db, "statusByPhase") ?? "{}");
  return new Engine(db, source, { prefix: ref.prefix, statusByPhase });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values: flags, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      instance: { type: "string", short: "i" },
      phase: { type: "string" },
      port: { type: "string" },
      database: { type: "string" },
      "candidate-property": { type: "string" },
      "candidate-value": { type: "string" },
      "status-property": { type: "string" },
      "tags-property": { type: "string" },
      "priority-property": { type: "string" },
      token: { type: "string" },
      "agent-kind": { type: "string" },
      "repo-cwd": { type: "string" },
      actor: { type: "string" },
      note: { type: "string" },
      force: { type: "boolean" },
    },
  });

  switch (cmd) {
    case "init": {
      const name = positionals[0];
      if (!name) throw new Error("usage: faktory init <name>");
      const ref = ensureInstanceDir(instanceRef(name));
      openDb(ref.dbPath).close();
      console.log(`instance ${ref.slug} ready at ${ref.dir} (prefix ${ref.prefix})`);
      break;
    }
    case "instances": {
      for (const slug of listInstances()) console.log(slug);
      break;
    }
    case "source:set-notion": {
      const { ref, db } = requireInstance(flags.instance);
      const databaseId = flags.database;
      const candidateProperty = flags["candidate-property"] ?? "Tags";
      const candidateValue = flags["candidate-value"] ?? `${ref.prefix}-execute`;
      if (!databaseId) throw new Error("--database <id> is required");
      const token = flags.token ?? process.env.NOTION_TOKEN;
      if (token) setSecret(db, "notion.token", token);
      const config = {
        databaseId,
        candidateProperty,
        candidateValue,
        statusProperty: flags["status-property"],
        tagsProperty: flags["tags-property"] ?? candidateProperty,
        priorityProperty: flags["priority-property"],
      };
      db.prepare(
        "INSERT INTO sources (id, kind, config) VALUES ('primary', 'notion', ?) ON CONFLICT(id) DO UPDATE SET kind='notion', config=excluded.config",
      ).run(JSON.stringify(config));
      console.log(`notion source configured: db ${databaseId}, candidacy ${candidateProperty} contains ${candidateValue}`);
      break;
    }
    case "sync": {
      const ctx = requireInstance(flags.instance);
      const fresh = await buildEngine(ctx).syncCandidates();
      console.log(`${fresh.length} new task(s) discovered`);
      for (const t of fresh) console.log(`  #${t.id} ${t.title}`);
      break;
    }
    case "tasks": {
      const ctx = requireInstance(flags.instance);
      const engine = buildEngine(ctx);
      for (const t of engine.tasks.list(flags.phase as Phase | undefined)) {
        console.log(`#${t.id}\t${t.phase}\t${t.title}\t${t.agentName ?? ""}`);
      }
      break;
    }
    case "transition": {
      const ctx = requireInstance(flags.instance);
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
      const ctx = requireInstance(flags.instance);
      const engine = buildEngine(ctx);
      let herdr: HerdrClient | undefined;
      try {
        herdr = HerdrClient.fromEnv();
      } catch {
        console.warn("warning: not inside herdr — dispatch disabled");
      }
      const server = createApiServer({
        engine,
        prefix: ctx.ref.prefix,
        herdr,
        dispatchDefaults: {
          agentKind: flags["agent-kind"] ?? getConfig(ctx.db, "agentKind") ?? "pi",
          repoCwd: flags["repo-cwd"] ?? getConfig(ctx.db, "repoCwd") ?? undefined,
        },
      });
      const port = Number(flags.port ?? getConfig(ctx.db, "port") ?? 4600);
      server.listen(port, "127.0.0.1", () => console.log(`faktory ${ctx.ref.prefix} on http://127.0.0.1:${port}`));
      break;
    }
    case "tui": {
      const ctx = requireInstance(flags.instance);
      new Tui(buildEngine(ctx), ctx.ref.prefix).start();
      break;
    }
    case undefined:
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
