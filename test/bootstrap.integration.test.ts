import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient } from "../src/herdr/client.ts";
import { bootstrapDetached, bootstrapWorkbench, TAB_LABELS } from "../src/herdr/bootstrap.ts";

/**
 * Integration test for the workbench bootstrap: a fake herdr socket answers the
 * request/response API and a fake `herdr` binary on PATH captures the shell-out
 * calls (`pane run`, `agent start`). We assert each component lands in its own
 * *named tab* rather than a split pane.
 */
let server: Server;
let dir: string;
let client: HerdrClient;
const socks = new Set<Socket>();

/** Requests seen by the fake socket, in order. Reset per test. */
let requests: Array<{ method: string; params: any }> = [];
/** Handler that maps a request to its `result`; swapped per test. */
let handler: (method: string, params: any) => any = () => ({});

let herdrLog: string;
let savedPath: string | undefined;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "fk-boot-"));
  const sockPath = join(dir, "herdr.sock");

  // Fake `herdr` binary: append its argv to a log, always succeed.
  herdrLog = join(dir, "herdr.log");
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const fakeBin = join(binDir, "herdr");
  writeFileSync(fakeBin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${herdrLog}"\nexit 0\n`);
  chmodSync(fakeBin, 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

  server = createServer((sock) => {
    socks.add(sock);
    sock.on("close", () => socks.delete(sock));
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        requests.push({ method: msg.method, params: msg.params });
        const result = handler(msg.method, msg.params);
        sock.write(JSON.stringify({ id: msg.id, result }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(sockPath, r));
  client = new HerdrClient(sockPath);
});

after(() => {
  for (const s of socks) s.destroy();
  server.close();
  if (savedPath !== undefined) process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  if (existsSync(herdrLog)) rmSync(herdrLog);
});

const OPTS = {
  instance: "fk",
  prefix: "faktory-fk",
  port: 4600,
  repoCwd: "/repo",
  faktoryBin: "/repo/bin/faktory",
  agentKind: "pi",
  tui: true,
  agent: true,
  serveCommand: "/repo/bin/faktory serve fk --no-tui --no-agent --port 4600",
};

function herdrCalls(): string[] {
  return existsSync(herdrLog) ? readFileSync(herdrLog, "utf8").trim().split("\n").filter(Boolean) : [];
}

test("fresh detached bootstrap puts serve, tui, orchestrator each in a named tab", async () => {
  let nextTab = 2;
  let nextPane = 2;
  handler = (method) => {
    switch (method) {
      case "workspace.list":
        return { workspaces: [] };
      case "pane.list":
        // claimWorkspace lists globally (empty) then per-workspace (root pane).
        return { panes: requests.filter((r) => r.method === "workspace.create").length ? [{ pane_id: "ws1:p1", tab_id: "ws1:t1" }] : [] };
      case "agent.list":
        return { agents: [] };
      case "workspace.create":
        return { workspace: { workspace_id: "ws1" } };
      case "tab.rename":
        return {};
      case "tab.create":
        return { tab: { tab_id: `ws1:t${nextTab++}` }, root_pane: { pane_id: `ws1:p${nextPane++}` } };
      case "pane.process_info":
        return { process_info: { shell_pid: 1, foreground_processes: [{ pid: 1 }] } };
      case "agent.prompt":
        return {};
      default:
        return {};
    }
  };

  const result = await bootstrapDetached(client, OPTS);

  assert.equal(result.workspaceId, "ws1");
  assert.equal(result.servePaneId, "ws1:p1");
  assert.equal(result.tuiPaneId, "ws1:p2");
  assert.equal(result.agentPaneId, "ws1:p3");
  assert.equal(result.agentName, "faktory-fk-orchestrator");

  // The root tab is renamed for the first component; the rest open new tabs.
  const rename = requests.find((r) => r.method === "tab.rename");
  assert.equal(rename?.params.label, TAB_LABELS.serve);
  assert.equal(rename?.params.tab_id, "ws1:t1");

  const tabLabels = requests.filter((r) => r.method === "tab.create").map((r) => r.params.label);
  assert.deepEqual(tabLabels, [TAB_LABELS.tui, TAB_LABELS.orchestrator]);

  // No pane splitting — the old layout mechanism must be gone.
  assert.ok(!requests.some((r) => r.method === "pane.split"), "must not split panes");

  // Commands were run in the tab panes; the orchestrator agent was started.
  const calls = herdrCalls();
  assert.ok(calls.some((c) => c.includes("pane run ws1:p1") && c.includes("serve fk")));
  assert.ok(calls.some((c) => c.includes("pane run ws1:p2") && c.includes("tui --instance fk")));
  assert.ok(calls.some((c) => c.includes("agent start faktory-fk-orchestrator")));
});

test("reattach leaves a fully-running workbench untouched (no new tabs, no runs)", async () => {
  handler = (method, params) => {
    switch (method) {
      case "workspace.list":
        return { workspaces: [{ workspace_id: "ws1", label: "faktory:fk" }] };
      case "pane.list":
        return {
          panes: [
            { pane_id: "ws1:p1", tab_id: "ws1:t1" },
            { pane_id: "ws1:p2", tab_id: "ws1:t2" },
          ],
        };
      case "tab.list":
        return {
          tabs: [
            { tab_id: "ws1:t1", label: TAB_LABELS.serve },
            { tab_id: "ws1:t2", label: TAB_LABELS.tui },
          ],
        };
      case "pane.process_info": {
        const cmd =
          params.pane_id === "ws1:p1"
            ? "node /repo/src/cli.ts serve --instance fk"
            : "node /repo/src/cli.ts tui --instance fk";
        return { process_info: { shell_pid: 1, foreground_processes: [{ pid: 2, cmdline: cmd }] } };
      }
      case "agent.list":
        return { agents: [{ agent_name: "faktory-fk-orchestrator" }] };
      default:
        return {};
    }
  };

  const result = await bootstrapDetached(client, OPTS);

  assert.equal(result.alreadyBootstrapped, true);
  assert.equal(result.agentAlreadyRunning, true);
  assert.ok(!requests.some((r) => r.method === "tab.create"), "must not open new tabs");
  assert.ok(!requests.some((r) => r.method === "tab.rename"), "must not relabel tabs");
  assert.deepEqual(herdrCalls(), [], "must not run any commands");
});

test("reattach restarts a dead tui by reusing its idle named tab", async () => {
  handler = (method, params) => {
    switch (method) {
      case "workspace.list":
        return { workspaces: [{ workspace_id: "ws1", label: "faktory:fk" }] };
      case "pane.list":
        return {
          panes: [
            { pane_id: "ws1:p1", tab_id: "ws1:t1" },
            { pane_id: "ws1:p2", tab_id: "ws1:t2" },
          ],
        };
      case "tab.list":
        return {
          tabs: [
            { tab_id: "ws1:t1", label: TAB_LABELS.serve },
            { tab_id: "ws1:t2", label: TAB_LABELS.tui },
          ],
        };
      case "pane.process_info": {
        // serve alive; tui pane fell back to an idle shell.
        if (params.pane_id === "ws1:p1")
          return { process_info: { shell_pid: 1, foreground_processes: [{ pid: 2, cmdline: "node /repo/src/cli.ts serve --instance fk" }] } };
        return { process_info: { shell_pid: 1, foreground_processes: [{ pid: 1 }] } };
      }
      case "agent.list":
        return { agents: [{ agent_name: "faktory-fk-orchestrator" }] };
      default:
        return {};
    }
  };

  const result = await bootstrapDetached(client, OPTS);

  assert.equal(result.tuiPaneId, "ws1:p2", "reuses the existing tui tab's idle pane");
  assert.ok(!requests.some((r) => r.method === "tab.create"), "no new tab when one can be reused");
  const calls = herdrCalls();
  assert.ok(calls.some((c) => c.includes("pane run ws1:p2") && c.includes("tui --instance fk")));
  assert.ok(!calls.some((c) => c.includes("serve fk")), "serve is left running");
});

test("reattach leaves a shared legacy tab alone (best-effort, no ambiguous relabel)", async () => {
  handler = (method, params) => {
    switch (method) {
      case "workspace.list":
        return { workspaces: [{ workspace_id: "ws1", label: "faktory:fk" }] };
      case "pane.list":
        // Legacy layout: serve + tui share one unlabelled tab as split panes.
        return {
          panes: [
            { pane_id: "ws1:p1", tab_id: "ws1:t1" },
            { pane_id: "ws1:p2", tab_id: "ws1:t1" },
          ],
        };
      case "tab.list":
        return { tabs: [{ tab_id: "ws1:t1", label: "faktory" }] };
      case "pane.process_info": {
        const cmd =
          params.pane_id === "ws1:p1"
            ? "node /repo/src/cli.ts serve --instance fk"
            : "node /repo/src/cli.ts tui --instance fk";
        return { process_info: { shell_pid: 1, foreground_processes: [{ pid: 2, cmdline: cmd }] } };
      }
      case "agent.list":
        return { agents: [{ agent_name: "faktory-fk-orchestrator" }] };
      default:
        return {};
    }
  };

  await bootstrapDetached(client, OPTS);

  // Two live components share t1 — it can't be split without a restart, so it
  // is left untouched rather than relabelled to one component arbitrarily.
  assert.ok(!requests.some((r) => r.method === "tab.rename"), "shared tab is not relabelled");
  assert.ok(!requests.some((r) => r.method === "tab.create"), "no new tabs for running components");
  assert.deepEqual(herdrCalls(), [], "running components are not restarted");
});

test("reattach relabels single-component legacy tabs (serve, tui, orchestrator)", async () => {
  handler = (method, params) => {
    switch (method) {
      case "workspace.list":
        return { workspaces: [{ workspace_id: "ws1", label: "faktory:fk" }] };
      case "pane.list":
        return {
          panes: [
            { pane_id: "ws1:p1", tab_id: "ws1:t1" },
            { pane_id: "ws1:p2", tab_id: "ws1:t2" },
            { pane_id: "ws1:p3", tab_id: "ws1:t3" },
          ],
        };
      case "tab.list":
        return {
          tabs: [
            { tab_id: "ws1:t1", label: "faktory" },
            { tab_id: "ws1:t2", label: "faktory" },
            { tab_id: "ws1:t3", label: "faktory" },
          ],
        };
      case "pane.process_info": {
        const cmd =
          params.pane_id === "ws1:p1"
            ? "node /repo/src/cli.ts serve --instance fk"
            : params.pane_id === "ws1:p2"
              ? "node /repo/src/cli.ts tui --instance fk"
              : "pi";
        return { process_info: { shell_pid: 1, foreground_processes: [{ pid: 2, cmdline: cmd }] } };
      }
      case "agent.list":
        return { agents: [{ agent_name: "faktory-fk-orchestrator", pane_id: "ws1:p3" }] };
      default:
        return {};
    }
  };

  await bootstrapDetached(client, OPTS);

  const renames = new Map(
    requests.filter((r) => r.method === "tab.rename").map((r) => [r.params.tab_id, r.params.label]),
  );
  assert.equal(renames.get("ws1:t1"), TAB_LABELS.serve);
  assert.equal(renames.get("ws1:t2"), TAB_LABELS.tui);
  assert.equal(renames.get("ws1:t3"), TAB_LABELS.orchestrator);
  assert.ok(!requests.some((r) => r.method === "tab.create"), "no new tabs for running components");
  assert.deepEqual(herdrCalls(), [], "running components are not restarted");
});

test("reattach opens a fresh named tab when a dead component has no labelled tab", async () => {
  handler = (method, params) => {
    switch (method) {
      case "workspace.list":
        return { workspaces: [{ workspace_id: "ws1", label: "faktory:fk" }] };
      case "pane.list":
        return { panes: [{ pane_id: "ws1:p1", tab_id: "ws1:t1" }] };
      case "tab.list":
        return { tabs: [{ tab_id: "ws1:t1", label: TAB_LABELS.serve }] };
      case "pane.process_info":
        // Only serve is alive; there is no tui tab to reuse.
        return {
          process_info: {
            shell_pid: 1,
            foreground_processes: [{ pid: 2, cmdline: "node /repo/src/cli.ts serve --instance fk" }],
          },
        };
      case "tab.create":
        return { tab: { tab_id: "ws1:t2" }, root_pane: { pane_id: "ws1:p2" } };
      case "agent.list":
        return { agents: [{ agent_name: "faktory-fk-orchestrator" }] };
      default:
        return {};
    }
  };

  const result = await bootstrapDetached(client, OPTS);

  const created = requests.filter((r) => r.method === "tab.create");
  assert.equal(created.length, 1);
  assert.equal(created[0]!.params.label, TAB_LABELS.tui);
  assert.equal(result.tuiPaneId, "ws1:p2");
  assert.ok(herdrCalls().some((c) => c.includes("pane run ws1:p2") && c.includes("tui --instance fk")));
});

test("adopt branch resolves the root tab id via pane.get when pane.list omits it", async () => {
  let renamedRootTab: string | undefined;
  handler = (method, params) => {
    switch (method) {
      case "workspace.list":
        return { workspaces: [{ workspace_id: "ws1", label: "other" }] };
      case "pane.list":
        // Single global pane with NO tab_id (adopt path) triggers the pane.get fallback.
        return { panes: [{ pane_id: "ws1:p1" }] };
      case "agent.list":
        return { agents: [] };
      case "workspace.rename":
        return {};
      case "pane.get":
        return { pane: { pane_id: params.pane_id, tab_id: "ws1:t1", workspace_id: "ws1" } };
      case "tab.rename":
        if (params.label === TAB_LABELS.serve) renamedRootTab = params.tab_id;
        return {};
      case "tab.create":
        return { tab: { tab_id: "ws1:tX" }, root_pane: { pane_id: "ws1:pX" } };
      case "pane.process_info":
        return { process_info: { shell_pid: 1, foreground_processes: [{ pid: 1 }] } };
      case "agent.prompt":
        return {};
      default:
        return {};
    }
  };

  const result = await bootstrapDetached(client, { ...OPTS, tui: false, agent: false });

  assert.equal(result.workspaceId, "ws1");
  assert.equal(result.servePaneId, "ws1:p1", "serve reuses the adopted root pane");
  assert.equal(renamedRootTab, "ws1:t1", "root tab id came from the pane.get fallback");
});

test("attached bootstrap labels the serve tab and opens tui + orchestrator tabs", async () => {
  let nextTab = 2;
  let nextPane = 2;
  handler = (method, params) => {
    switch (method) {
      case "pane.get":
        return { pane: { pane_id: params.pane_id, tab_id: "ws1:t1", workspace_id: "ws1" } };
      case "tab.rename":
        return {};
      case "tab.create":
        return { tab: { tab_id: `ws1:t${nextTab++}` }, root_pane: { pane_id: `ws1:p${nextPane++}` } };
      case "agent.list":
        return { agents: [] };
      case "pane.process_info":
        return { process_info: { shell_pid: 1, foreground_processes: [{ pid: 1 }] } };
      case "agent.prompt":
        return {};
      default:
        return {};
    }
  };

  const result = await bootstrapWorkbench(client, {
    ...OPTS,
    fromPaneId: "ws1:p1",
    serveTab: true,
  });

  // serve's own tab is renamed; tui + orchestrator each open a named tab.
  const rename = requests.find((r) => r.method === "tab.rename");
  assert.equal(rename?.params.tab_id, "ws1:t1");
  assert.equal(rename?.params.label, TAB_LABELS.serve);
  const tabLabels = requests.filter((r) => r.method === "tab.create").map((r) => r.params.label);
  assert.deepEqual(tabLabels, [TAB_LABELS.tui, TAB_LABELS.orchestrator]);
  assert.equal(result.tuiPaneId, "ws1:p2");
  assert.equal(result.agentPaneId, "ws1:p3");
  // A single pane.get covers both the serve label and the workspace lookup.
  assert.equal(requests.filter((r) => r.method === "pane.get").length, 1, "no redundant pane.get");
  assert.ok(!requests.some((r) => r.method === "pane.split"), "must not split panes");
});
