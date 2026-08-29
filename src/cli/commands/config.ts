import { Command } from "commander";
import { getConfig, setConfig } from "../../core/db.ts";
import { createPrompter, runSetup } from "../../setup.ts";
import {
  describeConfig,
  instanceRef,
  isYes,
  listInstances,
  removeInstance,
  requireInstance,
} from "../context.ts";
import { Option } from "commander";
import { selectedConfig, withConfigOption } from "../options.ts";

/**
 * `config` groups everything about configs (named orchestrations under
 * ~/.faktory/<slug>/). CRUD over the set of configs — `list`, `create`,
 * `delete` — and key/value settings inside one — `get`, `set`. This replaces
 * the old colon-namespaced `config:get` / `config:set` for a single, discoverable
 * verb space.
 */
export function registerConfig(program: Command): void {
  const config = program.command("config").description("manage configs (named orchestrations) and their settings");

  config
    .command("list")
    .alias("ls")
    .description("list configs with their prefix, port, and backlog db")
    .action(() => {
      const configs = listInstances();
      if (!configs.length) {
        console.log("no configs yet \u2014 run faktory config create (or faktory setup)");
        return;
      }
      for (const slug of configs) console.log(describeConfig(slug));
    });

  config
    .command("create [name]")
    .alias("new")
    .description("create a config (runs the setup wizard)")
    .addOption(new Option("-c, --config <name>", "name for the new config").hideHelp())
    .addOption(new Option("-i, --instance <name>", "deprecated alias of --config").hideHelp())
    .action(async (name: string | undefined, opts) => {
      const resolved = name ?? selectedConfig(opts);
      await runSetup(resolved ? { name: resolved } : {});
    });

  config
    .command("delete <name>")
    .alias("rm")
    .description("delete a config and its local state")
    .option("-f, --force", "skip the confirmation prompt")
    .action(async (name: string, opts: { force?: boolean }) => {
      const ref = instanceRef(name);
      if (!listInstances().includes(ref.slug))
        throw new Error(`config "${ref.slug}" does not exist (have: ${listInstances().join(", ") || "none"})`);
      if (!opts.force) {
        const ui = createPrompter();
        let ok = false;
        try {
          console.log(`Stop any running serve for "${ref.slug}" before deleting \u2014 this removes its SQLite DB and secrets.`);
          ok = isYes(await ui.ask(`Delete config "${ref.slug}" and all its local state in ${ref.dir}? (y/n)`, "n"));
        } finally {
          ui.close();
        }
        if (!ok) {
          console.log("aborted \u2014 nothing deleted");
          return;
        }
      }
      removeInstance(ref.slug);
      console.log(`deleted config "${ref.slug}" (${ref.dir})`);
      console.log("note: Notion ownership tags on already-claimed items are left as-is");
    });

  withConfigOption(config.command("get [key]").description("print a config setting (or all of them)")).action(
    (key: string | undefined, opts) => {
      const { db } = requireInstance(selectedConfig(opts));
      if (key) console.log(getConfig(db, key) ?? "");
      else
        for (const row of db.prepare("SELECT key, value FROM config ORDER BY key").all() as any[])
          console.log(`${row.key} = ${row.value}`);
    },
  );

  withConfigOption(config.command("set <key> <value>").description("persist a config setting"))
    .addHelpText(
      "after",
      "\nKeys: repoCwd, agentKind, port, herdrSession, wip (actionable-lane WIP target)",
    )
    .action((key: string, value: string, opts) => {
      const { db } = requireInstance(selectedConfig(opts));
      setConfig(db, key, value);
      console.log(`${key} = ${value}`);
    });
}
