import { Command } from "commander";
import { registerServe } from "./commands/serve.ts";
import { registerSetup } from "./commands/setup.ts";
import { registerConfig } from "./commands/config.ts";
import { registerSource } from "./commands/source.ts";
import { registerTasks } from "./commands/tasks.ts";
import { registerTui } from "./commands/tui.ts";
import { registerCollab } from "./commands/collab.ts";
import { registerOrchestrate } from "./commands/orchestrate.ts";

/**
 * Assemble the Commander program from the command registry. Adding a command is
 * one file under ./commands + one register call here — Commander derives help,
 * usage, and the "no args → subcommands and options" listing from the same
 * definitions, so nothing drifts. Each `register*` adds one top-level command
 * (or command group) and keeps its parsing next to its behavior.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("faktory")
    .description(
      "Local orchestration system that drives coding agents in herdr from an issue backlog (Notion).\n\n" +
        "A config is one named orchestration under ~/.faktory/<slug>/ with its own SQLite state,\n" +
        "secrets, port, and tag prefix (faktory-<slug>). Start with `faktory serve`.",
    )
    .configureHelp({ showGlobalOptions: true })
    .showHelpAfterError()
    .showSuggestionAfterError();

  const registrars = [
    registerServe,
    registerSetup,
    registerConfig,
    registerSource,
    registerTasks,
    registerTui,
    registerOrchestrate,
    registerCollab,
  ];
  for (const register of registrars) register(program);
  return program;
}

/** CLI entry point (invoked from src/cli.ts). */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  // No arguments → print subcommands and options to stdout and exit 0 (not the
  // stderr/exit-1 "missing command" error Commander emits by default).
  if (argv.slice(2).length === 0) {
    program.outputHelp();
    return;
  }
  await program.parseAsync(argv);
}
