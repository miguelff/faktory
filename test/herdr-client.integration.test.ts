import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient, HerdrError } from "../src/herdr/client.ts";

/**
 * Integration test: HerdrClient against a fake herdr unix-domain socket that
 * speaks the same newline-delimited JSON protocol.
 */
let server: Server;
let dir: string;
let client: HerdrClient;
const socks = new Set<import("node:net").Socket>();

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "fk-herdr-"));
  const sockPath = join(dir, "herdr.sock");
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
        const msg = JSON.parse(line);
        if (msg.method === "ping") {
          sock.write(JSON.stringify({ id: msg.id, result: { type: "pong", version: "test" } }) + "\n");
        } else if (msg.method === "agent.prompt") {
          sock.write(JSON.stringify({ id: msg.id, error: { code: "agent_blocked", message: "agent is blocked" } }) + "\n");
        } else if (msg.method === "events.subscribe") {
          sock.write(JSON.stringify({ id: msg.id, result: { type: "subscribed" } }) + "\n");
          // then stream two events
          sock.write(JSON.stringify({ type: "pane.agent_status_changed", pane_id: "w1:p1", status: "working" }) + "\n");
          sock.write(JSON.stringify({ type: "pane.agent_status_changed", pane_id: "w1:p1", status: "blocked" }) + "\n");
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(sockPath, r));
  client = new HerdrClient(sockPath);
});

after(() => {
  for (const s of socks) s.destroy();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("request/response round trip", async () => {
  const res = await client.request<any>("ping");
  assert.equal(res.type, "pong");
});

test("errors surface as HerdrError with the code", async () => {
  await assert.rejects(
    () => client.request("agent.prompt", { target: "x", text: "hi" }),
    (e: unknown) => e instanceof HerdrError && /agent_blocked/.test(e.message),
  );
});

test("subscribe streams events until disposed", async () => {
  const seen: string[] = [];
  let dispose: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    client
      .subscribe(["pane.agent_status_changed"], (ev) => {
        seen.push(ev.status);
        if (seen.length === 2) resolve();
      })
      .then((d) => (dispose = d));
  });
  await done;
  dispose?.();
  assert.deepEqual(seen, ["working", "blocked"]);
});
