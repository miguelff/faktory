import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HerdrClient } from "./client.ts";

const exec = promisify(execFile);

/**
 * herdr-side mechanics of bootstrapping the Faktory workbench. There is no
 * orchestrator *agent* any more — the loop is a deterministic engine that runs
 * inside the `serve` process. The workbench is just two named tabs:
 *
 *   serve — the API + engine loop (owns all state transitions + dispatch)
 *   board — the TUI kanban board + action feed
 *
 * Per-task work spaces (one herdr workspace per task, a tab per stage) are
 * provisioned on demand by the loop's dispatcher (src/herdr/dispatch.ts), not
 * here.
 */
export const TAB_LABELS = {
  serve: "serve",
  board: "board",
} as const;

export interface WorkbenchOptions {
  instance: string;
  prefix: string;
  port: number;
  repoCwd: string;
  faktoryBin: string;
  fromPaneId: string;
  board: boolean;
  /** Attached mode: label the tab that owns `fromPaneId` as the serve tab. */
  serveTab?: boolean;
  /** Detached mode: command that runs the API + loop in its own tab. */
  serveCommand?: string;
}

export interface WorkbenchResult {
  servePaneId?: string;
  boardPaneId?: string;
  workspaceId?: string;
  alreadyBootstrapped?: boolean;
}

export function workspaceLabel(instance: string): string {
  return `faktory:${instance}`;
}

export function paneIdOf(result: any): string {
  const pane = result?.pane ?? result;
  const id = pane?.pane_id ?? pane?.id;
  if (!id) throw new Error(`herdr returned no pane id: ${JSON.stringify(result)}`);
  return id;
}

async function createTab(herdr: HerdrClient, workspaceId: string, label: string, cwd: string): Promise<string> {
  const result = await herdr.request<any>("tab.create", { workspace_id: workspaceId, label, cwd, focus: false });
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

interface PaneProcess {
  paneId: string;
  cmdline: string;
}

async function paneProcess(herdr: HerdrClient, paneId: string): Promise<PaneProcess> {
  const info = (await herdr.request<any>("pane.process_info", { pane_id: paneId }))?.process_info ?? {};
  const foreground: any[] = info.foreground_processes ?? [];
  return { paneId, cmdline: foreground.map((p) => p.cmdline ?? "").join(" ") };
}

export function isBoardProcess(cmdline: string): boolean {
  return /cli\.ts\b.*\btui\b/.test(cmdline);
}

export function isServeProcess(cmdline: string): boolean {
  return /cli\.ts\b.*\bserve\b/.test(cmdline);
}

/**
 * Detached bootstrap: the session is driven over the socket. Sets up a
 * dedicated workspace (faktory:<instance>) with a serve tab and a board tab.
 * Idempotent: a session that already has the labelled workspace is reconciled.
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
  if (opts.board) {
    result.boardPaneId = await nextTab(TAB_LABELS.board);
    await runInPane(result.boardPaneId, `${cdRepo}${opts.faktoryBin} tui --config ${opts.instance}`);
  }
  return result;
}

/** Reconcile an existing workspace: live components stay, dead ones restart. */
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
  const labelOfTab = new Map<string, string>(tabs.map((t) => [tabId(t), t.label]));

  const componentPanes = new Set<string>(
    processes.filter((p) => isServeProcess(p.cmdline) || isBoardProcess(p.cmdline)).map((p) => p.paneId),
  );

  const ensureLabelled = async (pid: string, tabLabel: string): Promise<void> => {
    const owning = tabOfPane.get(pid);
    if (!owning) return;
    const shared = [...componentPanes].some((other) => other !== pid && tabOfPane.get(other) === owning);
    if (shared || labelOfTab.get(owning) === tabLabel) return;
    await renameTab(herdr, owning, tabLabel);
    labelOfTab.set(owning, tabLabel);
  };

  const claimTab = async (tabLabel: string): Promise<string> => {
    const existing = tabs.find((t) => t.label === tabLabel);
    if (existing) {
      const inTab = panes.filter((p) => p.tab_id === tabId(existing));
      if (inTab[0]) return paneId(inTab[0]);
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
  if (opts.board) {
    const running = processes.find((p) => isBoardProcess(p.cmdline));
    if (running) await ensureLabelled(running.paneId, TAB_LABELS.board);
    else {
      result.boardPaneId = await claimTab(TAB_LABELS.board);
      await runInPane(result.boardPaneId, `cd ${opts.repoCwd} && ${opts.faktoryBin} tui --config ${opts.instance}`);
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
 * opens the board (TUI) in its own named tab within the same workspace. With
 * `serveTab`, it also labels the `fromPaneId` tab "serve".
 */
export async function bootstrapWorkbench(herdr: HerdrClient, opts: WorkbenchOptions): Promise<WorkbenchResult> {
  const result: WorkbenchResult = {};
  const { tabId: fromTabId, workspaceId } = await paneInfo(herdr, opts.fromPaneId);
  if (opts.serveTab) await renameTab(herdr, fromTabId, TAB_LABELS.serve);

  if (opts.board) {
    result.boardPaneId = await createTab(herdr, workspaceId, TAB_LABELS.board, opts.repoCwd);
    await runInPane(result.boardPaneId, `${opts.faktoryBin} tui --config ${opts.instance}`);
  }
  return result;
}
