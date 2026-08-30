import { Command } from "commander";
import { PHASES, type Phase } from "../../core/types.ts";
import { canHandoff, isWorking } from "../../core/lifecycle.ts";
import { TaskStore } from "../../core/tasks.ts";
import { InboxStore } from "../../core/inbox.ts";
import { buildEngine, requireInstance } from "../context.ts";
import { selectedConfig, withConfigOption } from "../options.ts";

/**
 * `task` groups everything about the task table under one noun, mirroring the
 * `config <verb>` / `source <verb>` groups so the whole CLI reads as
 * `<resource> <verb>`: `task sync`, `task list`, `task transition`. The old
 * flat top-level verbs (`sync`, `tasks`, `transition`) survive as hidden,
 * deprecated aliases so existing scripts keep working.
 */
export function registerTask(program: Command): void {
  const task = program.command("task").description("sync, list, and move tasks through the lifecycle");

  withConfigOption(
    task.command("sync").description("pull candidates from the source into the task table"),
  ).action(syncAction);

  withConfigOption(withListOptions(task.command("list").alias("ls").description("list tasks"))).action(listAction);

  withConfigOption(
    task
      .command("show <id>")
      .description("one task: state, legal handoff targets, papertrail")
      .option("--json", "full detail as JSON — { id, phase, handoffs, title, body, trail, meta } fetched from the source"),
  ).action(showAction);

  withConfigOption(
    withTransitionOptions(task.command("transition <id> <phase>").description("move a task through the lifecycle")),
  ).action(transitionAction);

  // Deprecated flat aliases (pre-`task` grammar). Hidden from help, kept
  // working. Options are applied via the same `with*Options` helpers as the
  // real subcommands so the two can never drift apart.
  withConfigOption(
    program.command("sync", { hidden: true }).description("deprecated alias of `task sync`"),
  ).action(syncAction);
  withConfigOption(
    withListOptions(program.command("tasks", { hidden: true }).description("deprecated alias of `task list`")),
  ).action(listAction);
  withConfigOption(
    withTransitionOptions(
      program.command("transition <id> <phase>", { hidden: true }).description("deprecated alias of `task transition`"),
    ),
  ).action(transitionAction);
}

/** Options for `task list` — shared so the deprecated `tasks` alias can't drift. */
function withListOptions(cmd: Command): Command {
  return cmd.option("--phase <phase>", "filter by lifecycle phase");
}

/** Options for `task transition` — shared so the deprecated alias can't drift. */
function withTransitionOptions(cmd: Command): Command {
  return cmd
    .option("--actor <actor>", "who is making the change", "cli")
    .option("--note <note>", "note recorded in the audit trail")
    .option("--force", "bypass lifecycle validation (still audited)");
}

async function syncAction(opts: { config?: string; instance?: string }): Promise<void> {
  const ctx = requireInstance(selectedConfig(opts));
  const fresh = await buildEngine(ctx).syncCandidates();
  console.log(`${fresh.length} new task(s) discovered`);
  for (const t of fresh) console.log(`  #${t.id} ${t.title}`);
}

function listAction(opts: { config?: string; instance?: string; phase?: string }): void {
  const ctx = requireInstance(selectedConfig(opts));
  const engine = buildEngine(ctx);
  for (const t of engine.tasks.list(opts.phase as Phase | undefined)) {
    console.log(`#${t.id}\t${t.phase}\t${t.title}\t${t.agentName ?? ""}`);
  }
}

async function showAction(idRaw: string, opts: { config?: string; instance?: string; json?: boolean }): Promise<void> {
  const ctx = requireInstance(selectedConfig(opts));
  const tasks = new TaskStore(ctx.db);
  const t = tasks.byId(Number(idRaw));
  if (!t) throw new Error(`task ${idRaw} not found`);
  const handoffs = PHASES.filter((p) => canHandoff(t.phase, p));
  if (opts.json) {
    // The full task, source of truth included: title/body/trail/meta come from
    // the datasource (for Notion: page title, page blocks as markdown, the
    // comment feed, and the non-faktory page properties).
    const engine = buildEngine(ctx);
    const details = await engine.source.details(t.itemId);
    console.log(
      JSON.stringify(
        { id: t.id, phase: t.phase, handoffs, url: t.url, branch: t.branch, pr: t.prUrl, ...details },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`#${t.id} ${t.title}`);
  console.log(`phase     ${t.phase}${isWorking(t) ? ` (being worked by ${t.agentName})` : ""}`);
  console.log(`url       ${t.url}`);
  if (t.branch || t.prUrl) console.log(`branch    ${t.branch ?? "—"}    pr ${t.prUrl ?? "—"}`);
  console.log(`handoffs  ${handoffs.length ? handoffs.join(", ") : "(none — only a human can move it from here)"}`);
  const trail = new InboxStore(ctx.db).forTask(t.id).filter((m) => m.note || m.data);
  if (trail.length) {
    console.log("papertrail:");
    for (const m of trail) {
      const to = (m.data as any)?.to ? ` → ${(m.data as any).to}` : "";
      console.log(`  [${m.stage ?? "·"}]${to} ${m.note ?? "(data)"}${m.outcome ? `  (${m.outcome})` : ""}`);
    }
  }
  const events = tasks.events(t.id);
  if (events.length) {
    console.log("history:");
    for (const e of events.slice(-8)) console.log(`  ${e.at.slice(0, 19)}  ${e.from ?? "·"} → ${e.to}  [${e.actor}] ${e.note ?? ""}`);
  }
}

async function transitionAction(
  idRaw: string,
  to: string,
  opts: { config?: string; instance?: string; actor: string; note?: string; force?: boolean },
): Promise<void> {
  const ctx = requireInstance(selectedConfig(opts));
  const engine = buildEngine(ctx);
  const task = opts.force
    ? engine.tasks.transition(Number(idRaw), to as Phase, opts.actor, { force: true, note: opts.note })
    : await engine.transition(Number(idRaw), to as Phase, opts.actor, opts.note);
  console.log(`#${task.id} → ${task.phase}`);
}
