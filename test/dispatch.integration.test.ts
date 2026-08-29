import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient } from "../src/herdr/client.ts";
import { HerdrDispatcher } from "../src/herdr/loop-dispatcher.ts";
import { branchNameFor, stageAgentName, taskSpaceLabel } from "../src/herdr/dispatch.ts";
import type { Task } from "../src/core/types.ts";

let server: Server;
let dir: string;
let client: HerdrClient;
const socks = new Set<Socket>();
let requests: Array<{ method: string; params: any }> = [];
let handler: (method: string, params: any) => any = () => ({});
let herdrLog: string;
let savedPath: string | undefined;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "fk-dispatch-"));
  const sockPath = join(dir, "herdr.sock");
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
        sock.write(JSON.stringify({ id: msg.id, result: handler(msg.method, msg.params) }) + "\n");
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

function herdrCalls(): string[] {
  return existsSync(herdrLog) ? readFileSync(herdrLog, "utf8").trim().split("\n").filter(Boolean) : [];
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 3,
    sourceId: "primary",
    itemId: "p3",
    title: "Ship it",
    url: "u",
    phase: "shape",
    priority: 1,
    workspaceId: null,
    paneId: null,
    agentName: null,
    stage: null,
    dispatchedAt: null,
    attentionAt: null,
    branch: null,
    prUrl: null,
    error: null,
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

test("naming helpers are deterministic and namespaced by prefix", () => {
  assert.equal(stageAgentName("faktory-fk", 3, "shape"), "faktory-fk-t3-shape");
  assert.equal(taskSpaceLabel("faktory-fk", task()), "faktory-fk:t3");
  assert.match(branchNameFor(task({ title: "Ship it!" }), "faktory-fk"), /^faktory-fk\/3-ship-it$/);
});

test("first stage creates the task space (worktree) and reuses its root tab", async () => {
  handler = (method) => {
    switch (method) {
      case "worktree.create":
        return { workspace: { workspace_id: "ws3" }, root_pane: { pane_id: "ws3:p1" } };
      case "pane.get":
        return { pane: { pane_id: "ws3:p1", tab_id: "ws3:t1" } };
      case "pane.process_info":
        return { process_info: { shell_pid: 1, foreground_processes: [{ pid: 1 }] } };
      default:
        return {};
    }
  };
  const d = new HerdrDispatcher(client, "faktory-fk", { agentKind: "pi", repoCwd: "/repo" });
  const res = await d.dispatchStage(task(), "shape", "PROMPT");

  assert.equal(res.workspaceId, "ws3");
  assert.equal(res.paneId, "ws3:p1", "first stage reuses the space's root pane");
  assert.equal(res.agentName, "faktory-fk-t3-shape");

  const wt = requests.find((r) => r.method === "worktree.create")!;
  assert.equal(wt.params.branch, "faktory-fk/3-ship-it");
  assert.equal(wt.params.label, "faktory-fk:t3");
  // The root tab is relabelled for the stage; no extra tab is created.
  assert.equal(requests.find((r) => r.method === "tab.rename")?.params.label, "shape");
  assert.ok(!requests.some((r) => r.method === "tab.create"), "first stage reuses the root tab");

  const calls = herdrCalls();
  assert.ok(calls.some((c) => c.includes("agent start faktory-fk-t3-shape")));
  assert.ok(requests.some((r) => r.method === "agent.prompt" && r.params.text === "PROMPT"));
});

test("a later stage opens a new tab in the existing task space", async () => {
  handler = (method) => {
    switch (method) {
      case "tab.create":
        return { tab: { tab_id: "ws3:t2" }, root_pane: { pane_id: "ws3:p2" } };
      case "pane.process_info":
        return { process_info: { shell_pid: 1, foreground_processes: [{ pid: 1 }] } };
      default:
        return {};
    }
  };
  const d = new HerdrDispatcher(client, "faktory-fk", { agentKind: "pi", repoCwd: "/repo" });
  // Task already has a space (from the shaping stage).
  const res = await d.dispatchStage(task({ workspaceId: "ws3", branch: "faktory-fk/3-ship-it" }), "execute", "GO");

  assert.ok(!requests.some((r) => r.method === "worktree.create"), "space already exists");
  const created = requests.find((r) => r.method === "tab.create")!;
  assert.equal(created.params.workspace_id, "ws3");
  assert.equal(created.params.label, "execute");
  assert.equal(res.paneId, "ws3:p2");
  assert.equal(res.agentName, "faktory-fk-t3-execute");
});

test("agentStatus maps herdr agent state, and absent when the agent is gone", async () => {
  handler = (method) => {
    if (method === "agent.list")
      return { agents: [{ agent_name: "faktory-fk-t3-shape", status: "working" }] };
    return {};
  };
  const d = new HerdrDispatcher(client, "faktory-fk", { agentKind: "pi", repoCwd: "/repo" });
  assert.equal(await d.agentStatus("faktory-fk-t3-shape"), "working");
  assert.equal(await d.agentStatus("nobody"), "absent");
});

test("archiving a task closes its herdr space", async () => {
  handler = () => ({});
  const d = new HerdrDispatcher(client, "faktory-fk", { agentKind: "pi", repoCwd: "/repo" });
  await d.archiveTaskSpace(task({ workspaceId: "ws3" }));
  const closed = requests.find((r) => r.method === "workspace.close");
  assert.equal(closed?.params.workspace_id, "ws3");
});
