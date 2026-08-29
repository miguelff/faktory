import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient } from "../src/herdr/client.ts";
import { bootstrapDetached, TAB_LABELS } from "../src/herdr/bootstrap.ts";

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
