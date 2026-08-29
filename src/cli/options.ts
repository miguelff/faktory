import { Command, Option } from "commander";

/**
 * Attach the config selector every config-scoped command shares: `--config`
 * (canonical) plus the hidden, deprecated `--instance` alias. Returns the
 * command for chaining so registration reads top-to-bottom.
 */
export function withConfigOption(cmd: Command): Command {
  return cmd
    .option("-c, --config <name>", "config (named orchestration) to target")
    .addOption(new Option("-i, --instance <name>", "deprecated alias of --config").hideHelp());
}

/** Normalize the config selector from parsed options (canonical wins). */
export function selectedConfig(opts: { config?: string; instance?: string }): string | undefined {
  return opts.config ?? opts.instance;
}
