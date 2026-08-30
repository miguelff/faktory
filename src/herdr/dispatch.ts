import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { HerdrClient } from "./client.ts";
import type { Role, Task } from "../core/types.ts";
import type { RolePrompts } from "../core/stages.ts";

const exec = promisify(execFile);

/**
 * herdr-side mechanics of the pipeline: one **space** (worktree workspace) per
 * task, one **tab** per pipeline stage inside it, and archival that closes the
 * whole space. The engine loop owns *when* to dispatch; this module only knows
 * *how* to make herdr do it. No judgement here.
 */
export interface DispatchOptions {
  repoWorkspaceId?: string;
  repoCwd?: string;
  agentKind: string; // pi | claude | codex | hermes | ...
}

export interface StageDispatch {
  workspaceId: string;
  paneId: string;
  agentName: string;
  branch: string;
}

/** Branch name for a task's worktree: <prefix>/<id>-<slug>. */
export function branchNameFor(task: Task, prefix: string): string {
  const slug = task.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `${prefix}/${task.id}-${slug || "task"}`;
}

export function taskSpaceLabel(prefix: string, task: Task): string {
  return `${prefix}:t${task.id}`;
}

export function stageAgentName(prefix: string, taskId: number, stage: Role): string {
  return `${prefix}-t${taskId}-${stage}`;
}

function idOf(obj: any): string | undefined {
  return obj?.pane_id ?? obj?.id ?? obj?.workspace_id ?? obj?.tab_id;
}

/**
 * A freshly created pane's shell takes a moment to come up, and `agent.start`
 * rejects a non-idle pane (`agent_pane_busy`). Poll until the pane's only
 * foreground process is its own shell before starting the agent.
 */
async function waitForIdleShell(herdr: HerdrClient, paneId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = (await herdr.request<any>("pane.process_info", { pane_id: paneId }))?.process_info ?? {};
      const foreground: any[] = info.foreground_processes ?? [];
      if (foreground.length === 1 && foreground[0]?.pid === info.shell_pid) return;
    } catch {
      /* pane may not be registered yet */
    }
    await sleep(300);
  }
  throw new Error(`pane ${paneId} did not reach an idle shell within ${timeoutMs / 1000}s`);
}

/** Start an agent, retrying through the transient `agent_pane_busy` window. */
/**
 * Harnesses that accept a system prompt on their command line (appended to
 * their own, so AGENTS.md and the coding baseline stay intact). The role's
 * standing orders go there — they survive context compaction. Other kinds get
 * the system text prepended to the kickoff message instead.
 */
const SYSTEM_PROMPT_FLAG: Readonly<Record<string, string>> = {
  pi: "--append-system-prompt",
  claude: "--append-system-prompt",
};

async function startAgentWithRetry(
  agentName: string,
  agentKind: string,
  paneId: string,
  agentArgs: string[],
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const args = ["agent", "start", agentName, "--kind", agentKind, "--pane", paneId];
  if (agentArgs.length) args.push("--", ...agentArgs);
  for (;;) {
    try {
      // The CLI owns interactive readiness detection for agent startup.
      await exec("herdr", args);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (Date.now() >= deadline || !msg.includes("agent_pane_busy")) throw err;
      await sleep(500);
    }
  }
}

/**
 * Ensure the task's space (worktree workspace) exists, returning its id, branch,
 * and the id of its root pane (reused for the first stage tab). Idempotent: a
 * task that already has a `workspaceId` is left as-is.
 */
async function ensureTaskSpace(
  herdr: HerdrClient,
  task: Task,
  prefix: string,
  opts: DispatchOptions,
): Promise<{ workspaceId: string; branch: string; rootPaneId?: string }> {
  const branch = task.branch ?? branchNameFor(task, prefix);
  if (task.workspaceId) return { workspaceId: task.workspaceId, branch };
  const params = {
    ...(opts.repoWorkspaceId ? { workspace_id: opts.repoWorkspaceId } : {}),
    ...(opts.repoCwd ? { cwd: opts.repoCwd } : {}),
    branch,
    label: taskSpaceLabel(prefix, task),
    focus: false,
  };
  // The git worktree outlives the herdr session: after a session restart (or a
  // repaired stale assignment) the branch's worktree is still on disk, and
  // `worktree.create` fails on it. A task that already has a branch recorded
  // was provisioned before — reattach first; fall back to reattaching when a
  // fresh create trips over leftovers on disk.
  const created = task.branch
    ? await reattachOrCreateWorktree(herdr, params)
    : await createOrReattachWorktree(herdr, params);
  const workspaceId = idOf(created.workspace)!;
  const rootPaneId = idOf(created.root_pane);
  return { workspaceId, branch, rootPaneId };
}

async function reattachOrCreateWorktree(herdr: HerdrClient, params: Record<string, unknown>): Promise<any> {
  try {
    return await herdr.request<any>("worktree.open", params);
  } catch {
    return herdr.request<any>("worktree.create", params);
  }
}

async function createOrReattachWorktree(herdr: HerdrClient, params: Record<string, unknown>): Promise<any> {
  try {
    return await herdr.request<any>("worktree.create", params);
  } catch (err) {
    try {
      return await herdr.request<any>("worktree.open", params);
    } catch {
      throw err; // the create failure is the informative one
    }
  }
}

/**
 * Open a stage tab in the task's space and return the pane herdr opens in it.
 * The first stage reuses the space's root pane (from worktree.create).
 */
async function openStageTab(
  herdr: HerdrClient,
  workspaceId: string,
  stage: Role,
  cwd: string | undefined,
  rootPaneId: string | undefined,
): Promise<string> {
  if (rootPaneId) {
    // Reuse (and label) the space's root tab for the first stage.
    try {
      const info = (await herdr.request<any>("pane.get", { pane_id: rootPaneId }))?.pane ?? {};
      if (info.tab_id) await herdr.request("tab.rename", { tab_id: info.tab_id, label: stage });
    } catch {
      /* best-effort label */
    }
    return rootPaneId;
  }
  const result = await herdr.request<any>("tab.create", {
    workspace_id: workspaceId,
    label: stage,
    ...(cwd ? { cwd } : {}),
    focus: false,
  });
  const paneId = idOf(result?.root_pane);
  if (!paneId) throw new Error(`herdr tab.create returned no pane id: ${JSON.stringify(result)}`);
  return paneId;
}

/**
 * Dispatch one stage of a task: ensure its space, open the stage tab, start the
 * stage agent, and prompt it. Returns the herdr coordinates for the loop to
 * persist on the task.
 */
export async function dispatchStage(
  herdr: HerdrClient,
  task: Task,
  stage: Role,
  prompts: RolePrompts,
  prefix: string,
  opts: DispatchOptions,
): Promise<StageDispatch> {
  const { workspaceId, branch, rootPaneId } = await ensureTaskSpace(herdr, task, prefix, opts);
  const paneId = await openStageTab(herdr, workspaceId, stage, opts.repoCwd, rootPaneId);
  const agentName = stageAgentName(prefix, task.id, stage);
  await waitForIdleShell(herdr, paneId);
  const flag = SYSTEM_PROMPT_FLAG[opts.agentKind];
  await startAgentWithRetry(agentName, opts.agentKind, paneId, flag ? [flag, prompts.system] : []);
  const kickoff = flag ? prompts.kickoff : `${prompts.system}\n\n${prompts.kickoff}`;
  await herdr.request("agent.prompt", { target: agentName, text: kickoff });
  return { workspaceId, paneId, agentName, branch };
}

/** Archive a task's space: close its herdr workspace (conversations included). */
export async function archiveTaskSpace(herdr: HerdrClient, task: Task): Promise<void> {
  if (!task.workspaceId) return;
  await herdr.request("workspace.close", { workspace_id: task.workspaceId });
}
