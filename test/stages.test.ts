import { test } from "node:test";
import assert from "node:assert/strict";
import { rolePrompts } from "../src/core/stages.ts";
import type { StagePromptInput } from "../src/core/stages.ts";

/** Both halves joined, for assertions that don't care which side carries a line. */
function rolePrompt(role: Parameters<typeof rolePrompts>[0], input: StagePromptInput): string {
  const p = rolePrompts(role, input);
  return `${p.system}\n\n${p.kickoff}`;
}
import type { Task } from "../src/core/types.ts";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 7,
    sourceId: "primary",
    itemId: "page-7",
    title: "Add a widget",
    url: "https://notion.so/page-7",
    phase: "shape",
    priority: 3,
    workspaceId: null,
    paneId: null,
    agentName: null,
    stage: null,
    dispatchedAt: null,
    branch: null,
    prUrl: null,
    error: null,
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

const REPORT = "faktory report 7 --config fk --port 4600 --sender a --stage shape";

test("every role prompt states the task, and the exact report contract", () => {
  for (const stage of ["shape", "execute", "review", "release", "unblock"] as const) {
    const p = rolePrompt(stage, { task: task({ phase: stage === "unblock" ? "blocked" : stage }), reportCommand: REPORT });
    assert.match(p, /task #7: Add a widget/);
    assert.match(p, /faktory report 7 --config fk/, "embeds the report command");
    assert.match(p, /handoff\|note/, "requires a typed terminal message");
    assert.match(p, /NEVER moves on silence/, "the task stays until a handoff");
  }
});

test("shape prompt encodes the collaborative shaping process", () => {
  const p = rolePrompt("shape", { task: task(), reportCommand: REPORT });
  assert.match(p, /Ingest the raw idea/);
  assert.match(p, /Grill the user/);
  assert.match(p, /Iterate until sign-off/);
});

test("release prompt encodes the merge stage", () => {
  const p = rolePrompt("release", { task: task({ phase: "release" }), reportCommand: REPORT });
  assert.match(p, /Merge & release/);
  assert.match(p, /Merge the PR/);
});

test("unblock prompt carries the block reason and resume lane", () => {
  const p = rolePrompt("unblock", {
    task: task({ phase: "blocked" }),
    reason: "CI is red on main",
    cameFrom: "execute",
    reportCommand: REPORT,
  });
  assert.match(p, /Why it is blocked: CI is red on main/);
  assert.match(p, /Lane it was in: execute/);
  assert.match(p, /unblocking agent/);
  assert.match(p, /moves ONLY on the human's word/);
});

test("shape prompt moves only on the human's word", () => {
  const p = rolePrompt("shape", { task: task(), reportCommand: REPORT });
  assert.match(p, /ONLY when the user tells you/i);
  assert.match(p, /--to backlog/);
});

test("review prompt routes rework back to execute via handoff", () => {
  const p = rolePrompt("review", { task: task({ phase: "review" }), reportCommand: REPORT });
  assert.match(p, /--to execute/);
  assert.match(p, /--to release/);
});

test("the role's standing orders are the system prompt; the task is the kickoff", () => {
  const { system, kickoff } = rolePrompts("shape", { task: task(), reportCommand: REPORT });
  assert.match(system, /You are a feature\/bug shaping agent/);
  assert.match(system, /Grill the user/);
  assert.match(system, /--type handoff --to execute --note/, "tells it exactly how to hand off to execution");
  assert.match(system, /faktory report 7 --config fk/, "the report command is baked in");
  assert.doesNotMatch(system, /Add a widget/, "no task specifics in the standing orders");
  assert.match(kickoff, /task #7: Add a widget/);
});

test("the kickoff instructs fetching the task as JSON instead of inlining it", () => {
  const { kickoff } = rolePrompts("execute", {
    task: task({ phase: "execute" }),
    reportCommand: REPORT,
    taskCli: { show: "faktory task show 7 --config fk", list: "faktory task list --config fk" },
  });
  assert.match(kickoff, /faktory task show 7 --config fk --json/, "the reference + fetch command");
  assert.match(kickoff, /`body` \(the task's content as markdown\)/);
  assert.match(kickoff, /`trail` \(the/, "explains the comment-feed trail");
  assert.match(kickoff, /`meta`/);
  assert.doesNotMatch(kickoff, /Handoff trail from earlier stages/, "nothing inlined");
});

test("the standing orders teach the agent its faktory tooling", () => {
  const { system } = rolePrompts("execute", {
    task: task({ phase: "execute" }),
    reportCommand: REPORT,
    taskCli: { show: "faktory task show 7 --config fk", list: "faktory task list --config fk" },
  });
  assert.match(system, /## Faktory tooling/);
  assert.match(system, /faktory task show 7 --config fk/);
  assert.match(system, /faktory task list --config fk/);
  assert.match(system, /`task transition`, `config`, `serve`,\n\s+`invite`\) is for humans/);
});
