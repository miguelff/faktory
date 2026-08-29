import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HerdrClient } from "./client.ts";

/**
 * Faktory owns the herdr session, not the other way around: when serve runs
 * from a plain terminal it opens a new terminal window attached to a dedicated
 * herdr session (own server + socket, isolated from the user's main herdr) and
 * waits until its socket answers with a live pane.
 */
export interface EnsuredSession {
  client: HerdrClient;
  socketPath: string;
}

export function sessionSocketPath(name: string): string {
  return join(homedir(), ".config", "herdr", "sessions", name, "herdr.sock");
}

/** Env stripped so the new window is not treated as nested herdr. */
const HERDR_ENV_VARS = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"];

export function shellEscapeWord(word: string): string {
  return word.replace(/([^A-Za-z0-9_\-./=:])/g, "\\$1");
}

function applescriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function detached(cmd: string, args: string[]): void {
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

function openTerminalWithSession(name: string, cwd: string): void {
  const term = process.env.FAKTORY_TERM ?? process.env.TERM_PROGRAM ?? "Terminal";
  const herdrWords = ["env", ...HERDR_ENV_VARS.flatMap((v) => ["-u", v]), "herdr", "--session", name];
  if (/ghostty/i.test(term)) {
    detached("open", ["-na", "Ghostty", "--args", `--working-directory=${cwd}`, "-e", ...herdrWords]);
    return;
  }
  const cmd = `cd ${shellEscapeWord(cwd)} && ${herdrWords.map(shellEscapeWord).join(" ")}`;
  if (/iterm/i.test(term)) {
    detached("osascript", [
      "-e",
      `tell application "iTerm" to create window with default profile command "bash -lc '${applescriptString(cmd)}'"`,
    ]);
    return;
  }
  detached("osascript", [
    "-e",
    `tell application "Terminal" to do script "${applescriptString(cmd)}"`,
    "-e",
    'tell application "Terminal" to activate',
  ]);
}

async function liveClient(socketPath: string): Promise<HerdrClient | undefined> {
  if (!existsSync(socketPath)) return undefined;
  try {
    const client = new HerdrClient(socketPath);
    const res = await client.request<any>("pane.list", {}, 3_000);
    return (res?.panes?.length ?? 0) > 0 ? client : undefined;
  } catch {
    return undefined;
  }
}

/** A client for the named session, or undefined when its server isn't up. */
export function sessionClient(name: string): Promise<HerdrClient | undefined> {
  return liveClient(sessionSocketPath(name));
}

/** Wait for the named session's server to come up (someone else is starting it). */
export async function waitForSession(name: string, timeoutMs = 60_000): Promise<HerdrClient> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = await liveClient(sessionSocketPath(name));
    if (client) return client;
    await sleep(500);
  }
  throw new Error(`herdr session "${name}" did not come up within ${timeoutMs / 1000}s`);
}

/**
 * Attach the CURRENT terminal to the named session (blocking until the user
 * detaches/quits herdr). Creates the session server if it isn't running.
 * Inherited HERDR_* env is stripped so the client isn't treated as nested.
 */
export function attachSession(name: string): void {
  const env = { ...process.env };
  for (const v of HERDR_ENV_VARS) delete env[v];
  spawnSync("herdr", ["--session", name], { stdio: "inherit", env });
}

/**
 * Attach to the named session if its server is already up; otherwise open a
 * new terminal window running it and wait (up to `timeoutMs`) for readiness.
 */
export async function ensureSession(name: string, cwd: string, timeoutMs = 30_000): Promise<EnsuredSession> {
  const socketPath = sessionSocketPath(name);
  let client = await liveClient(socketPath);
  if (client) return { client, socketPath };

  openTerminalWithSession(name, cwd);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    client = await liveClient(socketPath);
    if (client) return { client, socketPath };
  }
  throw new Error(`herdr session "${name}" did not come up within ${timeoutMs / 1000}s (socket ${socketPath})`);
}
