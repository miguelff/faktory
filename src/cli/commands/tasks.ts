import { Command } from "commander";
import type { Phase } from "../../core/types.ts";
import { buildEngine, requireInstance } from "../context.ts";
import { selectedConfig, withConfigOption } from "../options.ts";

/** Read/write commands over the task table: `create`, `sync`, `tasks`, `transition`. */
export function registerTasks(program: Command): void {
  withConfigOption(
    program
      .command("create <title>")
      .description("create a new task in the source (owned by this config) in a chosen state")
      .option("--phase <phase>", "lifecycle phase to create it in", "queued")
      .option("--priority <n>", "numeric priority (larger = more important)")
      .option("--note <note>", "note recorded in the audit trail"),
  ).action(async (title: string, opts) => {
    const ctx = requireInstance(selectedConfig(opts));
    const engine = buildEngine(ctx);
    const task = await engine.createTask({
      title,
      phase: opts.phase as Phase,
      priority: opts.priority != null ? Number(opts.priority) : null,
      note: opts.note,
    });
    console.log(`#${task.id}\t${task.phase}\t${task.title}`);
  });

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
