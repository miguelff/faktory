import type { InboxMessage, Role, Task } from "./types.ts";

/**
 * Role prompts — the instructions the loop hands a dispatched agent for each
 * actionable lane (shaping, executing, reviewing, merging) plus the interactive
 * unblocking session it opens on a blocked task. Pure and source-independent:
 * the loop supplies the task, the handoff trail (prior inbox annotations), and
 * the exact `faktory report` command the agent must call to talk back.
 *
 * Every prompt ends with the same contract: the task moves only on a terminal
 * `handoff` message — never inferred. Sessions are interactive at every stage:
 * agents ask the human directly in their tab (herdr surfaces the question),
 * and the loop never second-guesses a quiet session.
 */

export interface StagePromptInput {
  task: Task;
  /** Prior handoff annotations, oldest first, injected as context. */
  handoff: InboxMessage[];
  /** Base `faktory report` invocation, already scoped to this task. */
  reportCommand: string;
  /** Why the task is blocked (unblock role only): the blocking transition's note. */
  reason?: string | null;
  /** Lane the task left when it was blocked (unblock role only). */
  cameFrom?: string | null;
}

const HUMAN_LABEL: Record<Role, string> = {
  shape: "shaping",
  execute: "execution",
  review: "review",
  release: "merging",
  unblock: "unblocking",
};

function handoffTrail(handoff: InboxMessage[]): string {
  const notes = handoff.filter((m) => m.note || m.data);
  if (notes.length === 0) return "There is no prior handoff — you are the first stage.";
  const lines = notes.map((m) => {
    const from = m.stage ? `[${m.stage}]` : "[·]";
    const data = m.data ? ` ${JSON.stringify(m.data)}` : "";
    return `- ${from} ${m.note ?? ""}${data}`.trimEnd();
  });
  return ["Handoff trail from earlier stages (read before you start):", ...lines].join("\n");
}

/** Roles that may route the task to blocked (the interactive ones talk to the human directly). */
const CAN_BLOCK: readonly Role[] = ["execute", "review", "release"];

/** Where each pipeline role sends the task when its work is done. */
const NEXT: Readonly<Partial<Record<Role, string>>> = {
  shape: "execute",
  execute: "review",
  review: "release",
  release: "done",
};

function contract(role: Role, reportCommand: string): string {
  const next = NEXT[role];
  return [
    "## Reporting back (required)",
    "You are a stage worker. You never move the task yourself and never edit the source.",
    "Everything you send back goes through the Faktory inbox with this command:",
    "",
    `    ${reportCommand} --type <handoff|note> --note "<summary>" --to <lane> [--data '<json>']`,
    "",
    "- Every move is a `handoff`: name the target lane with `--to` and put",
    "  everything the next role needs (decisions made, open questions, artifacts,",
    "  pointers) in `--note` and structured fields in `--data`. Every handoff is",
    "  mirrored to the source as a `<handoff from to>` comment — the papertrail.",
    ...(next ? [`- When your work here is done, send exactly one handoff with \`--to ${next}\`.`] : []),
    "- This is an interactive session: ask the human directly in this chat when",
    "  you need a decision.",
    ...(CAN_BLOCK.includes(role)
      ? [
          "- If you hit something only a human can resolve and this session cannot",
          "  continue, hand off with `--to blocked` and a note describing exactly",
          "  what is needed — the loop opens an unblocking session for the human.",
        ]
      : []),
    "- A `note` message annotates the papertrail without moving the task.",
    "- The task NEVER moves on silence — it stays with you until you hand it off.",
    `(role: ${role} — ${HUMAN_LABEL[role]})`,
  ].join("\n");
}

function shapePrompt(input: StagePromptInput): string {
  const { task } = input;
  return [
    `# Shape this task`,
    `Task #${task.id}: ${task.title}`,
    `Source: ${task.url}`,
    "",
    handoffTrail(input.handoff),
    "",
    "Run a collaborative shaping process with the human, in this order:",
    "1. Ingest the raw idea — restate the intent of the task as written.",
    "2. Ground it in reality — explore the codebase, docs, and the source to",
    "   understand current behavior, terminology, and constraints.",
    "3. Grill the human — ask a few targeted questions to resolve ambiguity and",
    "   challenge scope. Propose defaults instead of open-ended asks.",
    "4. Draft the shaped issue — context (current vs wanted), the wanted behavior",
    "   in concrete sections, acceptance criteria as a checklist, pointers to",
    "   affected code.",
    "5. Iterate until sign-off — present the draft, incorporate corrections, repeat",
    "   until the human explicitly agrees.",
    "",
    "This is an interactive session: the task moves ONLY when the human tells you",
    "so in this chat — never on your own judgement.",
    "- Human signs off → hand off with `--to execute`, the `--note` carrying the",
    "  shaped spec (context, wanted behavior, acceptance criteria, pointers).",
    "- Human decides it is not ready → hand off with `--to backlog` and a note",
    "  recording why.",
    "",
    contract("shape", input.reportCommand),
  ].join("\n");
}

function executePrompt(input: StagePromptInput): string {
  const { task } = input;
  return [
    `# Execute this task`,
    `Task #${task.id}: ${task.title}`,
    `Source: ${task.url}`,
    "",
    handoffTrail(input.handoff),
    "",
    "You are in a dedicated worktree on this task's branch. Implement the shaped",
    "spec above:",
    "- Comply with AGENTS.md (hexagonal boundaries, lifecycle as data, tests as spec).",
    "- Work in coherent Conventional Commits; write tests with the code.",
    "- `pnpm typecheck && pnpm test` must pass before you finish.",
    "- Open (or update) a PR against main when a remote exists; capture the PR URL.",
    "",
    "When the implementation is complete and green, hand off with `--to review`,",
    "a summary of what changed, and `--data '{\"pr\":\"<url>\"}'` when a PR exists.",
    "If something goes wrong that only a human can resolve, hand off with",
    "`--to blocked`.",
    "",
    contract("execute", input.reportCommand),
  ].join("\n");
}

function reviewPrompt(input: StagePromptInput): string {
  const { task } = input;
  return [
    `# Blind-review this task`,
    `Task #${task.id}: ${task.title}`,
    `Source: ${task.url}`,
    "",
    handoffTrail(input.handoff),
    "",
    "Review the change with NO access to the execution conversation — only the diff",
    "(`git diff main...HEAD`), the shaped spec, and the source. Judge correctness,",
    "edge cases, test coverage, AGENTS.md compliance, and simplicity.",
    "Collect findings as a numbered list with severity: blocker / should-fix / nit.",
    "",
    "- All feedback addressed (only nits remain) → hand off with `--to release`.",
    "- Blockers or should-fix findings remain → hand off with `--to execute`",
    "  listing them, so execution picks the task back up.",
    "- Something is wrong that neither lane can fix → hand off with `--to blocked`",
    "  describing it.",
    "",
    contract("review", input.reportCommand),
  ].join("\n");
}

function releasePrompt(input: StagePromptInput): string {
  const { task } = input;
  return [
    `# Merge & release this task`,
    `Task #${task.id}: ${task.title}`,
    `Source: ${task.url}`,
    "",
    handoffTrail(input.handoff),
    "",
    "The review passed. Land the change:",
    "- Rebase the branch on main if needed and make sure CI is green.",
    "- Merge the PR (or fast-forward main) following the repo's conventions.",
    "- Run any release/deploy step the repo defines for a merged change.",
    "",
    "When the change is merged (and released where applicable), hand off with",
    "`--to done` summarizing what landed. If merging is not possible (conflicts",
    "you cannot resolve, failing CI, missing permissions), hand off with",
    "`--to blocked` describing exactly what is in the way.",
    "",
    contract("release", input.reportCommand),
  ].join("\n");
}

function unblockPrompt(input: StagePromptInput): string {
  const { task } = input;
  return [
    `# Unblock this task`,
    `Task #${task.id}: ${task.title}`,
    `Source: ${task.url}`,
    "",
    `Why it is blocked: ${input.reason ?? "(no reason recorded — check the handoff trail and the feed)"}`,
    ...(input.cameFrom ? [`Lane it was in: ${input.cameFrom}`] : []),
    "",
    handoffTrail(input.handoff),
    "",
    "This is an interactive unblocking session with the human. Work through the",
    "blocker together:",
    "1. Explain, in plain terms, why the task is blocked and what is needed.",
    "2. Investigate whatever the human asks (code, logs, the source item).",
    "3. When the human resolves it, route the task where they say with a `handoff`",
    "   message: `--to <lane>` (usually the lane it was in) and a note recording",
    "   the resolution. The task moves ONLY on the human's word.",
    "",
    contract("unblock", input.reportCommand),
  ].join("\n");
}

const PROMPTS: Record<Role, (input: StagePromptInput) => string> = {
  shape: shapePrompt,
  execute: executePrompt,
  review: reviewPrompt,
  release: releasePrompt,
  unblock: unblockPrompt,
};

export function rolePrompt(role: Role, input: StagePromptInput): string {
  return PROMPTS[role](input);
}
