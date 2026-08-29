import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HerdrClient } from "./client.ts";
import type { Task } from "../core/types.ts";

const exec = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A freshly created worktree pane's shell takes a moment to come up, and
 * `agent.start` rejects a non-idle pane (`agent_pane_busy`). Poll until the
 * pane's only foreground process is its own shell before starting the agent.
 * Mirrors the guard in bootstrap.ts.
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

/**
 * Start the agent, retrying while herdr reports the pane as not-yet-available
 * (`agent_pane_busy`) — a transient state right after a worktree pane appears.
 */
async function startAgentWithRetry(
  agentName: string,
  agentKind: string,
  paneId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // The CLI owns interactive readiness detection for agent startup.
      await exec("herdr", ["agent", "start", agentName, "--kind", agentKind, "--pane", paneId]);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (Date.now() >= deadline || !msg.includes("agent_pane_busy")) throw err;
      await sleep(500);
    }
  }
}

/**
 * herdr-side mechanics of dispatching one task:
 * worktree.create (branch fk/<slug>) → agent.start (interactive readiness via
 * CLI) → agent.prompt "/kickoff <url>". Judgement stays with the caller.
 */
export interface DispatchOptions {
  /** Workspace id (or cwd) of the repo the worktree is created from. */
  repoWorkspaceId?: string;
  repoCwd?: string;
  agentKind: string; // pi | claude | codex | hermes | ...
  kickoffCommand?: string; // default "/kickoff"
}

export interface DispatchResult {
  workspaceId: string;
  paneId: string;
  agentName: string;
  branch: string;
}

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

export async function dispatchTask(
  herdr: HerdrClient,
  task: Task,
  prefix: string,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const branch = branchNameFor(task, prefix);

  const created = await herdr.request<any>("worktree.create", {
    ...(opts.repoWorkspaceId ? { workspace_id: opts.repoWorkspaceId } : {}),
    ...(opts.repoCwd ? { cwd: opts.repoCwd } : {}),
    branch,
    focus: false,
  });
  const workspaceId: string = created.workspace.id ?? created.workspace.workspace_id;
  const paneId: string = created.root_pane.id ?? created.root_pane.pane_id;

  const agentName = `${prefix}-t${task.id}`;
  // Wait for the worktree pane's shell to be idle; agent.start rejects a busy pane.
  await waitForIdleShell(herdr, paneId);
  // A worktree pane can report an idle shell before herdr treats it as an
  // "available shell" (agent_pane_busy). Retry agent.start through that window.
  await startAgentWithRetry(agentName, opts.agentKind, paneId);

  const kickoff = `${opts.kickoffCommand ?? "/kickoff"} ${task.url}`;
  await herdr.request("agent.prompt", { target: agentName, text: kickoff });

  return { workspaceId, paneId, agentName, branch };
}
