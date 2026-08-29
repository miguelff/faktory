import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { HerdrClient } from "./client.ts";

const exec = promisify(execFile);

/**
 * herdr-side mechanics of bootstrapping the Faktory workbench. Each component —
 * the API/web `serve`, the TUI, and the orchestrator agent — lives in its own
 * **named herdr tab** ("serve" / "tui" / "orchestrator") rather than a split
 * pane, so operators can find each one from herdr's tab bar. The orchestrator
 * agent is the policy brain — it runs a continuous loop over the task state
 * machine through the HTTP API (see skills/faktory-orchestrator).
 */

/** Labels for the named tabs the workbench provisions, one per component. */
export const TAB_LABELS = {
  serve: "serve",
  tui: "tui",
  orchestrator: "orchestrator",
} as const;
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
  /** Attached mode: label the tab that owns `fromPaneId` as the serve tab. */
  serveTab?: boolean;
  /** Detached mode: command that runs the API/web server in its own tab. */
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
  if (!id) throw new Error(`herdr returned no pane id: ${JSON.stringify(result)}`);
  return id;
}

/**
 * Create a named tab in a workspace and return the id of the pane herdr opens
 * inside it (where the component's command is then run). The tab id is
 * validated as a guard but not otherwise needed by callers.
 */
async function createTab(herdr: HerdrClient, workspaceId: string, label: string, cwd: string): Promise<string> {
  const result = await herdr.request<any>("tab.create", {
    workspace_id: workspaceId,
    label,
    cwd,
    focus: false,
  });
  const tab = result?.tab ?? result;
  if (!(tab?.tab_id ?? tab?.id)) throw new Error(`herdr tab.create returned no tab id: ${JSON.stringify(result)}`);
  return paneIdOf({ pane: result?.root_pane });
}

async function renameTab(herdr: HerdrClient, tabId: string, label: string): Promise<void> {
  await herdr.request("tab.rename", { tab_id: tabId, label });
}

async function paneInfo(herdr: HerdrClient, paneId: string): Promise<{ tabId: string; workspaceId: string }> {
  const info = (await herdr.request<any>("pane.get", { pane_id: paneId }))?.pane ?? {};
  const tabId = info.tab_id;
  const workspaceId = info.workspace_id;
  if (!tabId || !workspaceId) throw new Error(`pane ${paneId} has no tab/workspace id: ${JSON.stringify(info)}`);
  return { tabId, workspaceId };
}

async function runInPane(paneId: string, command: string): Promise<void> {
  await exec("herdr", ["pane", "run", paneId, command]);
}

async function agentExists(herdr: HerdrClient, name: string): Promise<boolean> {
  return !!(await findAgent(herdr, name));
}

/** Locate a named agent and the pane it runs in, or undefined if not present. */
async function findAgent(herdr: HerdrClient, name: string): Promise<{ paneId?: string } | undefined> {
  const result = await herdr.request<any>("agent.list", {});
  const agents: any[] = result?.agents ?? [];
  const found = agents.find((a) => (a.agent_name ?? a.name) === name);
  return found ? { paneId: found.pane_id ?? found.id } : undefined;
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

/** A freshly opened tab's pane shell takes a moment to come up; agent.start rejects a non-idle pane. */
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
 * Detached bootstrap: the session is driven over the socket (not from a serve
 * pane). Sets up a dedicated workspace (labelled faktory:<instance>) whose
 * components each get their own named tab: serve, tui, orchestrator. When
 * `serveCommand` is given, serve runs inside its own tab too. Idempotent: a
 * session that already has the labelled workspace is reconciled, not rebuilt.
 */
export async function bootstrapDetached(
  herdr: HerdrClient,
  opts: Omit<WorkbenchOptions, "fromPaneId">,
): Promise<WorkbenchResult> {
  const label = workspaceLabel(opts.instance);
  const workspaces: any[] = (await herdr.request<any>("workspace.list", {}))?.workspaces ?? [];
  const existing = workspaces.find((w) => w.label === label);
  if (existing) return reattachWorkspace(herdr, existing.workspace_id ?? existing.id, opts);

  const { workspaceId, rootPaneId, rootTabId } = await claimWorkspace(herdr, label, opts.repoCwd, workspaces);
  const result: WorkbenchResult = { workspaceId };

  const cdRepo = `cd ${opts.repoCwd} && `;
  // The workspace already has one (root) tab; reuse it for the first component
  // and open a fresh named tab for each of the rest.
  let rootUsed = false;
  const nextTab = async (tabLabel: string): Promise<string> => {
    if (!rootUsed) {
      rootUsed = true;
      await renameTab(herdr, rootTabId, tabLabel);
      return rootPaneId;
    }
    return createTab(herdr, workspaceId, tabLabel, opts.repoCwd);
  };

  if (opts.serveCommand) {
    result.servePaneId = await nextTab(TAB_LABELS.serve);
    await runInPane(result.servePaneId, `${cdRepo}${opts.serveCommand}`);
  }
  if (opts.tui) {
    result.tuiPaneId = await nextTab(TAB_LABELS.tui);
    await runInPane(result.tuiPaneId, `${cdRepo}${opts.faktoryBin} tui --instance ${opts.instance}`);
  }
  if (opts.agent) {
    const agentPaneId = await nextTab(TAB_LABELS.orchestrator);
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
 * Reconcile an existing workspace: running components are left in place (their
 * tab relabelled to match when it uniquely owns them), and a dead component is
 * restarted by reusing its same-labelled tab or opening a fresh named one.
 */
async function reattachWorkspace(
  herdr: HerdrClient,
  workspaceId: string,
  opts: Omit<WorkbenchOptions, "fromPaneId">,
): Promise<WorkbenchResult> {
  const result: WorkbenchResult = { workspaceId, alreadyBootstrapped: true };
  const panes: any[] = (await herdr.request<any>("pane.list", { workspace_id: workspaceId }))?.panes ?? [];
  if (!panes.length) throw new Error(`workspace ${workspaceId} has no pane`);
  const tabs: any[] = (await herdr.request<any>("tab.list", { workspace_id: workspaceId }))?.tabs ?? [];
  const processes = await Promise.all(panes.map((p) => paneProcess(herdr, p.pane_id ?? p.id)));
  const paneId = (p: any): string => p.pane_id ?? p.id;
  const tabId = (t: any): string => t.tab_id ?? t.id;
  const tabOfPane = new Map<string, string>(panes.map((p) => [paneId(p), p.tab_id]));
  const idleByPane = new Map(processes.map((p) => [p.paneId, p.idleShell]));
  const labelOfTab = new Map<string, string>(tabs.map((t) => [tabId(t), t.label]));

  const agentName = orchestratorAgentName(opts.prefix);
  const agent = opts.agent ? await findAgent(herdr, agentName) : undefined;

  // Panes that already host a Faktory component; used to detect legacy tabs
  // where several components share one tab (they can't be separated without a
  // restart, so we leave such tabs alone rather than relabel ambiguously).
  const componentPanes = new Set<string>(
    processes.filter((p) => isServeProcess(p.cmdline) || isTuiProcess(p.cmdline)).map((p) => p.paneId),
  );
  if (agent?.paneId) componentPanes.add(agent.paneId);

  // Label the tab that owns a running component's pane — but only when that
  // component uniquely owns the tab (migrates the common one-tab-per-component
  // case; shared legacy tabs are left as-is, best-effort).
  const ensureLabelled = async (pid: string, tabLabel: string): Promise<void> => {
    const owning = tabOfPane.get(pid);
    if (!owning) return;
    const shared = [...componentPanes].some((other) => other !== pid && tabOfPane.get(other) === owning);
    if (shared || labelOfTab.get(owning) === tabLabel) return;
    await renameTab(herdr, owning, tabLabel);
    labelOfTab.set(owning, tabLabel);
  };

  // Restart a dead component into its own named tab: reuse the same-labelled
  // tab if one exists (never duplicate a label), preferring an idle pane in it;
  // otherwise open a fresh named tab.
  const claimTab = async (tabLabel: string): Promise<string> => {
    const existing = tabs.find((t) => t.label === tabLabel);
    if (existing) {
      const inTab = panes.filter((p) => p.tab_id === tabId(existing));
      const pick = inTab.find((p) => idleByPane.get(paneId(p))) ?? inTab[0];
      if (pick) return paneId(pick);
    }
    return createTab(herdr, workspaceId, tabLabel, opts.repoCwd);
  };

  if (opts.serveCommand) {
    const running = processes.find((p) => isServeProcess(p.cmdline));
    if (running) await ensureLabelled(running.paneId, TAB_LABELS.serve);
    else {
      result.servePaneId = await claimTab(TAB_LABELS.serve);
      await runInPane(result.servePaneId, `cd ${opts.repoCwd} && ${opts.serveCommand}`);
    }
  }
  if (opts.tui) {
    const running = processes.find((p) => isTuiProcess(p.cmdline));
    if (running) await ensureLabelled(running.paneId, TAB_LABELS.tui);
    else {
      result.tuiPaneId = await claimTab(TAB_LABELS.tui);
      await runInPane(result.tuiPaneId, `cd ${opts.repoCwd} && ${opts.faktoryBin} tui --instance ${opts.instance}`);
    }
  }
  if (opts.agent) {
    if (agent) {
      result.agentName = agentName;
      result.agentAlreadyRunning = true;
      if (agent.paneId) await ensureLabelled(agent.paneId, TAB_LABELS.orchestrator);
    } else {
      result.agentPaneId = await claimTab(TAB_LABELS.orchestrator);
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
): Promise<{ workspaceId: string; rootPaneId: string; rootTabId: string }> {
  const panes: any[] = (await herdr.request<any>("pane.list", {}))?.panes ?? [];
  const agents: any[] = (await herdr.request<any>("agent.list", {}))?.agents ?? [];
  if (workspaces.length === 1 && panes.length === 1 && agents.length === 0) {
    const workspaceId = workspaces[0].workspace_id ?? workspaces[0].id;
    await herdr.request("workspace.rename", { workspace_id: workspaceId, label });
    return resolveRoot(herdr, workspaceId, panes[0]);
  }
  const created = await herdr.request<any>("workspace.create", { label, cwd, focus: true });
  const workspaceId = created?.workspace?.workspace_id ?? created?.workspace?.id ?? created?.workspace_id;
  if (!workspaceId) throw new Error(`herdr workspace.create returned no workspace id: ${JSON.stringify(created)}`);
  const wsPanes: any[] = (await herdr.request<any>("pane.list", { workspace_id: workspaceId }))?.panes ?? [];
  return resolveRoot(herdr, workspaceId, wsPanes[0]);
}

/**
 * Root pane + tab of a workspace. `tab_id` should be present on the pane, but
 * the global pane listing used by the adopt path may omit it, so fall back to a
 * direct pane.get.
 */
async function resolveRoot(
  herdr: HerdrClient,
  workspaceId: string,
  root: any,
): Promise<{ workspaceId: string; rootPaneId: string; rootTabId: string }> {
  const rootPaneId = root?.pane_id ?? root?.id;
  if (!rootPaneId) throw new Error(`workspace ${workspaceId} has no pane`);
  const rootTabId = root.tab_id ?? (await paneInfo(herdr, rootPaneId)).tabId;
  return { workspaceId, rootPaneId, rootTabId };
}

/**
 * Attached bootstrap: `serve` already runs in its own pane (`fromPaneId`); this
 * opens the TUI and orchestrator agent each in their own named tab within the
 * same workspace. With `serveTab`, it also labels the `fromPaneId` tab "serve"
 * (one pane.get serves both the label and the workspace lookup).
 */
export async function bootstrapWorkbench(
  herdr: HerdrClient,
  opts: WorkbenchOptions,
): Promise<WorkbenchResult> {
  const result: WorkbenchResult = {};
  const { tabId: fromTabId, workspaceId } = await paneInfo(herdr, opts.fromPaneId);
  if (opts.serveTab) await renameTab(herdr, fromTabId, TAB_LABELS.serve);

  if (opts.tui) {
    result.tuiPaneId = await createTab(herdr, workspaceId, TAB_LABELS.tui, opts.repoCwd);
    await runInPane(result.tuiPaneId, `${opts.faktoryBin} tui --instance ${opts.instance}`);
  }

  if (opts.agent) {
    const agentName = orchestratorAgentName(opts.prefix);
    if (await agentExists(herdr, agentName)) {
      result.agentName = agentName;
      result.agentAlreadyRunning = true;
    } else {
      result.agentPaneId = await createTab(herdr, workspaceId, TAB_LABELS.orchestrator, opts.repoCwd);
      const started = await startOrchestrator(herdr, result.agentPaneId, opts);
      result.agentName = started.agentName;
      result.agentAlreadyRunning = started.alreadyRunning;
    }
  }

  return result;
}
