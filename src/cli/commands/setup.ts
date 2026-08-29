import { Command } from "commander";
import { runSetup } from "../../setup.ts";

/** `setup` runs the terminal wizard standalone (reconfigure without serving). */
export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("run the setup wizard standalone (reconfigure without serving)")
    .action(async () => {
      await runSetup();
    });
}
