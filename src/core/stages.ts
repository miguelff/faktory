import type { InboxMessage, Stage, Task } from "./types.ts";

/**
 * Stage prompts — the instructions the loop hands a dispatched agent for each
 * actionable lane. Pure and source-independent: the loop supplies the task, the
 * handoff trail (prior inbox annotations), and the exact `faktory report`
 * command the agent must call to talk back through the inbox.
 *
 * Every stage prompt ends with the same contract: the agent MUST send a typed
 * terminal message (`completed` or `needs_human`) before it goes quiet. The
 * loop never infers completion from silence — a quiet agent with no message is
 * a stall, not a success.
 */

export interface StagePromptInput {
  task: Task;
  /** Prior handoff annotations, oldest first, injected as context. */
  handoff: InboxMessage[];
  /** Base `faktory report` invocation, already scoped to this task. */
  reportCommand: string;
}

const HUMAN_LABEL: Record<Stage, string> = {
  to_shape: "shaping",
  to_execute: "execution",
  to_review: "review",
};

function handoffTrail(handoff: InboxMessage[]): string {
  const notes = handoff.filter((m) => m.note || m.data);
  if (notes.length === 0) return "There is no prior handoff — you are the first stage.";
  const lines = notes.map((m) => {
    const from = m.stage ? `[${m.stage}]` : "[·]";
    const data = m.data ? ` ${JSON.stringify(m.data)}` : "";
    return `- ${from} ${m.note ?? ""}${data}`.trimEnd();
  });
  return ["Handoff from earlier stages (read before you start):", ...lines].join("\n");
}

function contract(stage: Stage, reportCommand: string): string {
  return [
    "## Reporting back (required)",
    "You are a stage worker. You never move the task yourself and never edit the source.",
    "Everything you send back goes through the Faktory inbox with this command:",
    "",
    `    ${reportCommand} --type <completed|needs_human> --note "<summary>" [--data '<json>']`,
    "",
    "- When your stage is done, send exactly one `completed` message. Put everything",
    "  the next stage needs (decisions made, open questions, artifacts, pointers) in",
    "  `--note` and structured fields in `--data` — this becomes the handoff trail.",
    `- If you need a human decision, send a \`needs_human\` message describing the`,
    `  question, then wait for the human to answer in this tab. The loop surfaces it`,
    `  and may move the task to Blocked until it is answered.`,
    "- Do NOT go quiet without sending one of these. Silence is treated as a stall,",
    "  never as success.",
    `(stage: ${stage} — ${HUMAN_LABEL[stage]})`,
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
    "6. Hand off — on agreement, send a `completed` message whose `--note` carries",
    "   the shaped spec (context, wanted behavior, acceptance criteria, pointers).",
    "",
    contract("to_shape", input.reportCommand),
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
    "When the implementation is complete and green, send a `completed` message with",
    "a summary of what changed and `--data '{\"pr\":\"<url>\"}'` when a PR exists.",
    "",
    contract("to_execute", input.reportCommand),
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
    "- If only nits remain, send a `completed` message: review passed, ready.",
    "- If blockers/should-fix remain, send a `needs_human` message listing them so",
    "  the loop can route the task back to execution or to a human.",
    "",
    contract("to_review", input.reportCommand),
  ].join("\n");
}

const PROMPTS: Record<Stage, (input: StagePromptInput) => string> = {
  to_shape: shapePrompt,
  to_execute: executePrompt,
  to_review: reviewPrompt,
};

export function stagePrompt(stage: Stage, input: StagePromptInput): string {
  return PROMPTS[stage](input);
}
