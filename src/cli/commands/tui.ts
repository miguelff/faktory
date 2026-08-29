import { Command } from "commander";
import { Tui } from "../../tui/tui.ts";
import { buildEngine, requireInstance } from "../context.ts";
import { selectedConfig, withConfigOption } from "../options.ts";

/** `tui` opens the terminal inspector/repair board for a config. */
export function registerTui(program: Command): void {
  withConfigOption(program.command("tui").description("inspect / repair state in the terminal")).action((opts) => {
    const ctx = requireInstance(selectedConfig(opts));
    new Tui(buildEngine(ctx), ctx.ref.prefix).start();
  });
}
