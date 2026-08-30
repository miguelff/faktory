import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ensureInstanceDir, instanceRef, listInstances, removeInstance } from "../core/instance.ts";
import { getConfig, getSecret, openDb } from "../core/db.ts";
import { Engine } from "../core/engine.ts";
import { createSource } from "../sources/factory.ts";
import { createPrompter, runSetup } from "../setup.ts";
import { bootstrapDetached } from "../herdr/bootstrap.ts";
import { attachSession, destroySession, sessionClient, sessionSocketPath, waitForSession } from "../herdr/session.ts";

/**
 * Shared plumbing for the command layer. Commands (`src/cli/commands/*.ts`)
 * import from here so each one stays a thin adapter over the domain: parse the
 * Commander-validated inputs, resolve a config, build an Engine, call it. No
 * argument parsing, help text, or Notion/herdr specifics live here — those
 * belong to Commander and the domain respectively.
 */

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FAKTORY_BIN = join(REPO_ROOT, "bin", "faktory");

/** Common options every config-scoped command accepts. */
export interface ConfigOpts {
  /** --config NAME (or the deprecated --instance alias, normalized upstream). */
  config?: string;
}

export interface InstanceCtx {
  ref: ReturnType<typeof instanceRef>;
  db: ReturnType<typeof openDb>;
}

/** Open the state DB for an existing, named config; throw with guidance if none. */
export function requireInstance(name: string | undefined): InstanceCtx {
  const instances = listInstances();
  const slug = name ?? (instances.length === 1 ? instances[0] : undefined);
  if (!slug)
    throw new Error(
      `--config required (available: ${instances.join(", ") || "none — run faktory serve to set one up"})`,
    );
  const ref = instanceRef(slug);
  // Fail with guidance rather than a raw "unable to open database file" when a
  // named config doesn't exist (parity with resolveExistingConfig's message).
  if (!instances.includes(ref.slug))
    throw new Error(`config "${ref.slug}" does not exist (available: ${instances.join(", ") || "none"})`);
  const db = openDb(ref.dbPath);
  return { ref, db };
}

/** Build an Engine bound to a config's sole source, wiring in secrets + prefix. */
export function buildEngine(ctx: InstanceCtx): Engine {
  const { ref, db } = ctx;
  const sourceRow = db.prepare("SELECT * FROM sources LIMIT 1").get() as any;
  if (!sourceRow) throw new Error("no source configured — run faktory source set-notion");
  const source = createSource(
    { id: sourceRow.id, kind: sourceRow.kind, config: JSON.parse(sourceRow.config) },
    { getSecret: (k) => getSecret(db, k), prefix: ref.prefix },
  );
  return new Engine(db, source, { prefix: ref.prefix });
}

export function hasSource(ctx: InstanceCtx): boolean {
  return !!ctx.db.prepare("SELECT 1 FROM sources LIMIT 1").get();
}

/** Accept both "y" and "yes" (case-insensitive) as confirmation. */
export function isYes(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}

/** One-line summary of a config for `config list`: prefix, port, backlog db. */
export function describeConfig(slug: string): string {
  const ref = instanceRef(slug);
  try {
    const db = openDb(ref.dbPath);
    try {
      const src = db.prepare("SELECT config FROM sources LIMIT 1").get() as { config: string } | undefined;
      const port = getConfig(db, "port") ?? "4600";
      const dbId = src ? (JSON.parse(src.config).databaseId ?? "?") : "(no source)";
      return `${slug}\t${ref.prefix}\tport ${port}\t${dbId}`;
    } finally {
      db.close();
    }
  } catch {
    return slug;
  }
}

/**
 * Resolve which config serve should run: the requested one (setup runs when it
 * doesn't exist yet), the only one, or a terminal pick among the existing
 * configs plus "start a new one". No configs at all → the setup wizard.
 */
export async function resolveServeConfig(requested: string | undefined): Promise<string> {
  const configs = listInstances();
  if (requested) {
    const slug = instanceRef(requested).slug;
    if (configs.includes(slug)) return slug;
    console.log(`config "${slug}" does not exist yet — starting setup`);
    return runSetup({ name: requested });
  }
  const NEW = "(start a new config)";
  const DELETE = "(delete a config)";
  // Loop so deleting a config returns to the picker instead of exiting; the
  // wizard opens its own prompter, so ui is always closed before calling it.
  while (true) {
    const current = listInstances();
    if (current.length === 0) return runSetup();
    if (current.length === 1) return current[0]!;
    const ui = createPrompter();
    let choice: string;
    try {
      choice = await ui.pick("Which config?", [...current, NEW, DELETE], (s) => s);
      if (choice === DELETE) {
        const CANCEL = "(cancel)";
        const target = await ui.pick("Delete which config?", [...current, CANCEL], (s) => s, current.length);
        if (target !== CANCEL) {
          const ref = instanceRef(target);
          const ok = isYes(
            await ui.ask(
              `Delete "${ref.slug}"? This stops its herdr session (serve, board, agents) and removes all its local state in ${ref.dir}. (y/n)`,
              "n",
            ),
          );
          if (ok) {
            deleteConfig(ref.slug);
            console.log(`deleted config "${ref.slug}"`);
          }
        }
        continue;
      }
    } finally {
      ui.close();
    }
    return choice === NEW ? runSetup() : choice;
  }
}

/**
 * Resolve which existing config a command targets: the requested one, the only
 * one, or a terminal pick among the existing configs. Unlike serve, there is
 * no "start a new one" option — the config must already exist.
 */
export async function resolveExistingConfig(requested: string | undefined): Promise<string> {
  const configs = listInstances();
  if (requested) {
    const slug = instanceRef(requested).slug;
    if (!configs.includes(slug))
      throw new Error(`config "${slug}" does not exist (available: ${configs.join(", ") || "none"})`);
    return slug;
  }
  if (configs.length === 0) throw new Error("no configs yet — run faktory serve to set one up");
  if (configs.length === 1) return configs[0]!;
  const ui = createPrompter();
  try {
    return await ui.pick("Which config?", configs, (s) => s);
  } finally {
    ui.close();
  }
}

/**
 * One herdr session per config, isolated from every other config's session
 * (own server, socket, workspaces, worktrees). `herdrSession` config overrides.
 */
export function sessionNameFor(slug: string): string {
  return `faktory-${slug}`;
}

/**
 * Delete a config: tear down its herdr session first (stopping the server
 * kills every process that depends on it — the serve loop, the board, any
 * stage agents), then remove its local state directory. Returns false when no
 * such config exists.
 */
export function deleteConfig(slug: string): boolean {
  const ref = instanceRef(slug);
  if (!listInstances().includes(ref.slug)) return false;
  let sessionName = sessionNameFor(ref.slug);
  try {
    const db = openDb(ref.dbPath);
    sessionName = getConfig(db, "herdrSession") ?? sessionName;
    db.close();
  } catch {
    /* unreadable state DB — fall back to the default session name */
  }
  if (destroySession(sessionName)) console.log(`stopped herdr session "${sessionName}" (and everything running in it)`);
  return removeInstance(ref.slug);
}

/** Detached workbench: the serve tab (API + engine loop) and the board tab (TUI). */
export function detachedWorkbench(slug: string, port: number) {
  return {
    instance: slug,
    prefix: instanceRef(slug).prefix,
    port,
    repoCwd: REPO_ROOT,
    faktoryBin: FAKTORY_BIN,
    board: true,
    serveCommand: `${FAKTORY_BIN} serve ${slug} --no-board --port ${port}`,
  };
}

/**
 * Launcher mode: make sure the workbench runs INSIDE the session (serve tab +
 * board tab), then attach the current terminal to it. When the session server
 * isn't up yet, attaching starts it and a detached provisioner sets the panes
 * up as soon as the socket answers.
 */
export async function launchAndAttach(slug: string, sessionName: string, port: number): Promise<void> {
  const client = await sessionClient(sessionName);
  if (client) {
    process.env.HERDR_SOCKET_PATH = sessionSocketPath(sessionName);
    const result = await bootstrapDetached(client, detachedWorkbench(slug, port));
    if (result.servePaneId) console.log(`serve tab (pane ${result.servePaneId})`);
    if (result.boardPaneId) console.log(`board tab (pane ${result.boardPaneId})`);
  } else {
    spawn(FAKTORY_BIN, ["__provision", slug, "--session", sessionName, "--port", String(port)], {
      detached: true,
      stdio: "ignore",
    }).unref();
    console.log(`starting herdr session "${sessionName}" — the workbench provisions itself once it's up`);
  }
  console.log(`attaching to herdr session "${sessionName}" — board on http://127.0.0.1:${port}`);
  attachSession(sessionName);
}

export { ensureInstanceDir, instanceRef, listInstances, removeInstance, waitForSession };
