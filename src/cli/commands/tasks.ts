import { Command } from "commander";
import type { Phase } from "../../core/types.ts";
import { buildEngine, requireInstance } from "../context.ts";
import { selectedConfig, withConfigOption } from "../options.ts";

/** Read/write commands over the task table: `sync`, `tasks`, `transition`. */
export function registerTasks(program: Command): void {
  withConfigOption(program.command("sync").description("pull candidates from the source into the task table")).action(
    async (opts) => {
      const ctx = requireInstance(selectedConfig(opts));
      const fresh = await buildEngine(ctx).syncCandidates();
      console.log(`${fresh.length} new task(s) discovered`);
      for (const t of fresh) console.log(`  #${t.id} ${t.title}`);
    },
  );

  withConfigOption(
    program.command("tasks").description("list tasks").option("--phase <phase>", "filter by lifecycle phase"),
  ).action((opts) => {
    const ctx = requireInstance(selectedConfig(opts));
    const engine = buildEngine(ctx);
    for (const t of engine.tasks.list(opts.phase as Phase | undefined)) {
      console.log(`#${t.id}\t${t.phase}\t${t.title}\t${t.agentName ?? ""}`);
    }
  });

  withConfigOption(
    program
      .command("transition <id> <phase>")
      .description("move a task through the lifecycle")
      .option("--actor <actor>", "who is making the change", "cli")
      .option("--note <note>", "note recorded in the audit trail")
      .option("--force", "bypass lifecycle validation (still audited)"),
  ).action(async (idRaw: string, to: string, opts) => {
    const ctx = requireInstance(selectedConfig(opts));
    const engine = buildEngine(ctx);
    const task = opts.force
      ? engine.tasks.transition(Number(idRaw), to as Phase, opts.actor, { force: true, note: opts.note })
      : await engine.transition(Number(idRaw), to as Phase, opts.actor, opts.note);
    console.log(`#${task.id} → ${task.phase}`);
  });
}
