import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { HerdrClient } from "./client.ts";

const exec = promisify(execFile);

/**
 * herdr-side mechanics of bootstrapping the Faktory workbench around the
 * `serve` pane: a TUI pane and an orchestrator agent pane. The orchestrator
 * agent is the policy brain — it runs a continuous loop over the task state
 * machine through the HTTP API (see skills/faktory-orchestrator).
 */
export interface WorkbenchOptions {
  instance: string;
  prefix: string;
  port: number;
  repoCwd: string;
  faktoryBin: string;
  agentKind: string;
  fromPaneId: string;
  tui: boolean;
  agent: boolean;
  /** Detached mode: command that runs the API/web server in its own pane. */
  serveCommand?: string;
}

export interface WorkbenchResult {
  servePaneId?: string;
  tuiPaneId?: string;
  agentPaneId?: string;
  agentName?: string;
  agentAlreadyRunning?: boolean;
  workspaceId?: string;
  alreadyBootstrapped?: boolean;
}

export function workspaceLabel(instance: string): string {
  return `faktory:${instance}`;
}

export function orchestratorAgentName(prefix: string): string {
  return `${prefix}-orchestrator`;
}

/**
 * Harness-agnostic: the loop itself is defined by the skill file, referenced
 * by path so any agent kind (pi, claude, codex, ...) can follow it without a
 * harness-specific skill-loading mechanism.
 */
export function orchestratorPrompt(opts: {
  instance: string;
  prefix: string;
  port: number;
}): string {
  const api = `http://127.0.0.1:${opts.port}`;
  return [
    `You are the orchestrator of Faktory instance "${opts.instance}" (prefix ${opts.prefix}).`,
    `Read skills/faktory-orchestrator/SKILL.md in this repo and follow it exactly. The Faktory API is at ${api}.`,
    `Run a continuous loop over the task state machine: sync, then act on every task according to its phase`,
    `(discovered → queue by priority; queued → dispatch when a concurrency slot is free;`,
    `running → monitor the herdr agent and unblock or escalate; reviewing → judge the outcome;`,
    `blocked/failed → surface, never force). Keep at most 2 tasks in running/reviewing.`,
    `After each pass report a one-line status summary, wait a bit, and repeat. Do not stop until told to.`,
  ].join(" ");
}

export function paneIdOf(result: any): string {
  const pane = result?.pane ?? result;
  const id = pane?.pane_id ?? pane?.id;
  if (!id) throw new Error(`herdr pane.split returned no pane id: ${JSON.stringify(result)}`);
  return id;
}

async function splitPane(
  herdr: HerdrClient,
  fromPaneId: string,
  direction: "right" | "down",
  ratio: number,
  cwd: string,
): Promise<string> {
  const result = await herdr.request<any>("pane.split", {
    target_pane_id: fromPaneId,
    direction,
    ratio,
    cwd,
    focus: false,
  });
  return paneIdOf(result);
}

async function runInPane(paneId: string, command: string): Promise<void> {
  await exec("herdr", ["pane", "run", paneId, command]);
}

async function agentExists(herdr: HerdrClient, name: string): Promise<boolean> {
  const result = await herdr.request<any>("agent.list", {});
  const agents: any[] = result?.agents ?? [];
  return agents.some((a) => (a.agent_name ?? a.name) === name);
}

interface PaneProcess {
  paneId: string;
  idleShell: boolean;
  cmdline: string;
}

async function paneProcess(herdr: HerdrClient, paneId: string): Promise<PaneProcess> {
  const info = (await herdr.request<any>("pane.process_info", { pane_id: paneId }))?.process_info ?? {};
  const foreground: any[] = info.foreground_processes ?? [];
  return {
    paneId,
    idleShell: foreground.length === 1 && foreground[0]?.pid === info.shell_pid,
    cmdline: foreground.map((p) => p.cmdline ?? "").join(" "),
  };
}

/** A freshly split pane's shell takes a moment to come up; agent.start rejects a non-idle pane. */
async function waitForIdleShell(herdr: HerdrClient, paneId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await paneProcess(herdr, paneId)).idleShell) return;
    } catch {
      /* pane may not be registered yet */
    }
    await sleep(300);
  }
  throw new Error(`pane ${paneId} did not reach an idle shell within ${timeoutMs / 1000}s`);
}

export async function startOrchestrator(
  herdr: HerdrClient,
  paneId: string,
  opts: Pick<WorkbenchOptions, "instance" | "prefix" | "port" | "agentKind">,
): Promise<{ agentName: string; alreadyRunning: boolean }> {
  const agentName = orchestratorAgentName(opts.prefix);
  if (await agentExists(herdr, agentName)) return { agentName, alreadyRunning: true };
  await waitForIdleShell(herdr, paneId);
  // The CLI owns interactive readiness detection for agent startup.
  await exec("herdr", ["agent", "start", agentName, "--kind", opts.agentKind, "--pane", paneId]);
  await herdr.request("agent.prompt", { target: agentName, text: orchestratorPrompt(opts) });
  return { agentName, alreadyRunning: false };
}

/**
 * Detached bootstrap: serve runs outside herdr and owns the session. Sets up a
 * dedicated workspace (labelled faktory:<instance>) with the TUI on the left
 * and the orchestrator agent on the right. Idempotent: a session that already
 * has the labelled workspace is left untouched.
 */
export async function bootstrapDetached(
  herdr: HerdrClient,
  opts: Omit<WorkbenchOptions, "fromPaneId">,
): Promise<WorkbenchResult> {
  const label = workspaceLabel(opts.instance);
  const workspaces: any[] = (await herdr.request<any>("workspace.list", {}))?.workspaces ?? [];
  const existing = workspaces.find((w) => w.label === label);
  if (existing) return reattachWorkspace(herdr, existing.workspace_id ?? existing.id, opts);

  const { workspaceId, rootPaneId } = await claimWorkspace(herdr, label, opts.repoCwd, workspaces);
  const result: WorkbenchResult = { workspaceId };

  const cdRepo = `cd ${opts.repoCwd} && `;
  let anchor = rootPaneId;
  let anchorUsed = false;
  const nextPane = async (ratio: number) => {
    if (!anchorUsed) {
      anchorUsed = true;
      return anchor;
    }
    anchor = await splitPane(herdr, anchor, "right", ratio, opts.repoCwd);
    return anchor;
  };

  if (opts.serveCommand) {
    result.servePaneId = await nextPane(0);
    await runInPane(result.servePaneId, `${cdRepo}${opts.serveCommand}`);
  }
  if (opts.tui) {
    result.tuiPaneId = await nextPane(0.67);
    await runInPane(result.tuiPaneId, `${cdRepo}${opts.faktoryBin} tui --instance ${opts.instance}`);
  }
  if (opts.agent) {
    const agentPaneId = await nextPane(0.5);
    const started = await startOrchestrator(herdr, agentPaneId, opts);
    result.agentPaneId = agentPaneId;
    result.agentName = started.agentName;
    result.agentAlreadyRunning = started.alreadyRunning;
  }
  return result;
}

export function isTuiProcess(cmdline: string): boolean {
  return /cli\.ts\b.*\btui\b/.test(cmdline);
}

export function isServeProcess(cmdline: string): boolean {
  return /cli\.ts\b.*\bserve\b/.test(cmdline);
}

/**
 * Reconcile an existing workspace: panes are preserved and idle shell panes
 * reused before splitting new ones; a dead TUI or orchestrator is restarted.
 */
async function reattachWorkspace(
  herdr: HerdrClient,
  workspaceId: string,
  opts: Omit<WorkbenchOptions, "fromPaneId">,
): Promise<WorkbenchResult> {
  const result: WorkbenchResult = { workspaceId, alreadyBootstrapped: true };
  const panes: any[] = (await herdr.request<any>("pane.list", { workspace_id: workspaceId }))?.panes ?? [];
  const anchor = panes[0]?.pane_id ?? panes[0]?.id;
  if (!anchor) throw new Error(`workspace ${workspaceId} has no pane`);
  const processes = await Promise.all(panes.map((p) => paneProcess(herdr, p.pane_id ?? p.id)));
  const idle = processes.filter((p) => p.idleShell).map((p) => p.paneId);
  const claimPane = async () => idle.shift() ?? (await splitPane(herdr, anchor, "right", 0.5, opts.repoCwd));

  if (opts.serveCommand && !processes.some((p) => isServeProcess(p.cmdline))) {
    result.servePaneId = await claimPane();
    await runInPane(result.servePaneId, `cd ${opts.repoCwd} && ${opts.serveCommand}`);
  }
  if (opts.tui && !processes.some((p) => isTuiProcess(p.cmdline))) {
    result.tuiPaneId = await claimPane();
    await runInPane(result.tuiPaneId, `cd ${opts.repoCwd} && ${opts.faktoryBin} tui --instance ${opts.instance}`);
  }
  if (opts.agent) {
    const agentName = orchestratorAgentName(opts.prefix);
    if (await agentExists(herdr, agentName)) {
      result.agentName = agentName;
      result.agentAlreadyRunning = true;
    } else {
      result.agentPaneId = await claimPane();
      const started = await startOrchestrator(herdr, result.agentPaneId, opts);
      result.agentName = started.agentName;
      result.agentAlreadyRunning = started.alreadyRunning;
    }
  }
  return result;
}

/** A fresh session's only empty pane is adopted; otherwise a new workspace is created. */
async function claimWorkspace(
  herdr: HerdrClient,
  label: string,
  cwd: string,
  workspaces: any[],
): Promise<{ workspaceId: string; rootPaneId: string }> {
  const panes: any[] = (await herdr.request<any>("pane.list", {}))?.panes ?? [];
  const agents: any[] = (await herdr.request<any>("agent.list", {}))?.agents ?? [];
  if (workspaces.length === 1 && panes.length === 1 && agents.length === 0) {
    const workspaceId = workspaces[0].workspace_id ?? workspaces[0].id;
    await herdr.request("workspace.rename", { workspace_id: workspaceId, label });
    return { workspaceId, rootPaneId: panes[0].pane_id ?? panes[0].id };
  }
  const created = await herdr.request<any>("workspace.create", { label, cwd, focus: true });
  const workspaceId = created?.workspace?.workspace_id ?? created?.workspace?.id ?? created?.workspace_id;
  if (!workspaceId) throw new Error(`herdr workspace.create returned no workspace id: ${JSON.stringify(created)}`);
  const wsPanes: any[] = (await herdr.request<any>("pane.list", { workspace_id: workspaceId }))?.panes ?? [];
  const rootPaneId = wsPanes[0]?.pane_id ?? wsPanes[0]?.id;
  if (!rootPaneId) throw new Error(`workspace ${workspaceId} has no pane`);
  return { workspaceId, rootPaneId };
}

/**
 * Layout, split from the serve pane — the agent loop sits next to the TUI:
 *   serve | tui | orchestrator agent
 */
export async function bootstrapWorkbench(
  herdr: HerdrClient,
  opts: WorkbenchOptions,
): Promise<WorkbenchResult> {
  const result: WorkbenchResult = {};

  if (opts.tui) {
    result.tuiPaneId = await splitPane(herdr, opts.fromPaneId, "right", 0.5, opts.repoCwd);
    await runInPane(result.tuiPaneId, `${opts.faktoryBin} tui --instance ${opts.instance}`);
  }

  if (opts.agent) {
    const agentName = orchestratorAgentName(opts.prefix);
    if (await agentExists(herdr, agentName)) {
      result.agentName = agentName;
      result.agentAlreadyRunning = true;
    } else {
      const anchor = result.tuiPaneId ?? opts.fromPaneId;
      result.agentPaneId = await splitPane(herdr, anchor, "right", 0.5, opts.repoCwd);
      const started = await startOrchestrator(herdr, result.agentPaneId, opts);
      result.agentName = started.agentName;
      result.agentAlreadyRunning = started.alreadyRunning;
    }
  }

  return result;
}
