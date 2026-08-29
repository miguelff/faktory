import { test } from "node:test";
import assert from "node:assert/strict";
import { stagePrompt } from "../src/core/stages.ts";
import type { InboxMessage, Task } from "../src/core/types.ts";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 7,
    sourceId: "primary",
    itemId: "page-7",
    title: "Add a widget",
    url: "https://notion.so/page-7",
    phase: "to_shape",
    priority: 3,
    workspaceId: null,
    paneId: null,
    agentName: null,
    stage: null,
    dispatchedAt: null,
    resumePhase: null,
    branch: null,
    prUrl: null,
    error: null,
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

const REPORT = "faktory report 7 --config fk --port 4600 --sender a --stage to_shape";

test("every stage prompt states the task, and the exact report contract", () => {
  for (const stage of ["to_shape", "to_execute", "to_review"] as const) {
    const p = stagePrompt(stage, { task: task({ phase: stage }), handoff: [], reportCommand: REPORT });
    assert.match(p, /Task #7: Add a widget/);
    assert.match(p, /faktory report 7 --config fk/, "embeds the report command");
    assert.match(p, /completed\|needs_human/, "requires a typed terminal message");
    assert.match(p, /Silence is treated as a stall/, "forbids going quiet");
  }
});

test("to_shape prompt encodes the collaborative shaping process", () => {
  const p = stagePrompt("to_shape", { task: task(), handoff: [], reportCommand: REPORT });
  assert.match(p, /Ingest the raw idea/);
  assert.match(p, /Grill the human/);
  assert.match(p, /Iterate until sign-off/);
});

test("handoff trail is injected oldest-first when present", () => {
  const handoff: InboxMessage[] = [
    {
      id: 1,
      taskId: 7,
      stage: "to_shape",
      type: "completed",
      sender: "a",
      note: "shaped: build X with Y",
      data: { pointers: "src/x.ts" },
      createdAt: "t",
      appliedAt: "t",
      outcome: "applied",
    },
  ];
  const p = stagePrompt("to_execute", { task: task({ phase: "to_execute" }), handoff, reportCommand: REPORT });
  assert.match(p, /Handoff from earlier stages/);
  assert.match(p, /shaped: build X with Y/);
  assert.match(p, /pointers/);
});

test("no handoff yields the first-stage note", () => {
  const p = stagePrompt("to_shape", { task: task(), handoff: [], reportCommand: REPORT });
  assert.match(p, /no prior handoff/);
});
