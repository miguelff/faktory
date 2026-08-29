import { Command } from "commander";
import { getSecret, openDb, setSecret } from "../../core/db.ts";
import { createSource } from "../../sources/factory.ts";
import { ensureInstanceDir, instanceRef } from "../context.ts";
import { selectedConfig, withConfigOption } from "../options.ts";

/**
 * `source` configures a config's work source non-interactively. `set-notion`
 * is the scripted counterpart to the setup wizard: it creates the config if it
 * doesn't exist yet and provisions the Notion ownership properties.
 */
export function registerSource(program: Command): void {
  const source = program.command("source").description("configure a config's work source non-interactively");

  withConfigOption(
    source
      .command("set-notion")
      .description("configure the Notion source (creates the config if needed)")
      .requiredOption("--database <id>", "Notion backlog database id")
      .option("--priority-property <name>", "number property used for priority")
      .option("--token <token>", "Notion integration token (defaults to $NOTION_TOKEN)"),
  ).action(async (opts) => {
    const name = selectedConfig(opts);
    if (!name) throw new Error("--config <name> is required");
    const ref = ensureInstanceDir(instanceRef(name));
    const db = openDb(ref.dbPath);
    const databaseId = opts.database as string;
    const token = (opts.token as string | undefined) ?? process.env.NOTION_TOKEN;
    if (token) setSecret(db, "notion.token", token);
    const config = { databaseId, priorityProperty: opts.priorityProperty as string | undefined };
    db.prepare(
      "INSERT INTO sources (id, kind, config) VALUES ('primary', 'notion', ?) ON CONFLICT(id) DO UPDATE SET kind='notion', config=excluded.config",
    ).run(JSON.stringify(config));
    console.log(`notion source configured: db ${databaseId}, owner id ${ref.prefix}`);
    // Add the faktory_* ownership properties to the database if missing.
    const src = createSource(
      { id: "primary", kind: "notion", config: config as unknown as Record<string, unknown> },
      { getSecret: (k) => getSecret(db, k), prefix: ref.prefix },
    );
    if (src.ensureProperties) {
      const created = await src.ensureProperties();
      if (created.length) console.log(`added ownership propert${created.length === 1 ? "y" : "ies"}: ${created.join(", ")}`);
    }
  });
}
