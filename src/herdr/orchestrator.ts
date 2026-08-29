import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HerdrClient } from "./client.ts";
import type { Task } from "../core/types.ts";

const exec = promisify(execFile);

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
  // The CLI owns interactive readiness detection for agent startup.
  await exec("herdr", ["agent", "start", agentName, "--kind", opts.agentKind, "--pane", paneId]);

  const kickoff = `${opts.kickoffCommand ?? "/kickoff"} ${task.url}`;
  await herdr.request("agent.prompt", { target: agentName, text: kickoff });

  return { workspaceId, paneId, agentName, branch };
}
