import { Command } from "commander";
import { getConfig } from "../../core/db.ts";
import { createApiServer } from "../../api/server.ts";
import { HerdrClient } from "../../herdr/client.ts";
import { HerdrDispatcher } from "../../herdr/loop-dispatcher.ts";
import { bootstrapDetached, bootstrapWorkbench } from "../../herdr/bootstrap.ts";
import { sessionSocketPath, waitForSession } from "../../herdr/session.ts";
import { Loop } from "../../core/loop.ts";
import type { Engine } from "../../core/engine.ts";
import type { Stage, Task } from "../../core/types.ts";
import { runSetup } from "../../setup.ts";
import { ensureDependencies, harnessDependency, herdrDependency } from "../../deps.ts";
import {
  buildEngine,
  detachedWorkbench,
  FAKTORY_BIN,
  hasSource,
  launchAndAttach,
  REPO_ROOT,
  requireInstance,
  resolveServeConfig,
  sessionNameFor,
} from "../context.ts";
import { selectedConfig, withConfigOption } from "../options.ts";

const DEFAULT_WIP = 3;
const DEFAULT_STALL_MS = 5 * 60_000;
const DEFAULT_TICK_MS = 5_000;

/**
 * `serve` is the single readiness gate that makes Faktory usable: resolve (or
 * set up) a config, ensure every external tool exists, then either move into a
 * herdr pane and attach the current terminal, or (inside a pane / headless)
 * start the API + the deterministic engine loop and bootstrap the board.
 *
 * The engine loop lives here — this process owns all state transitions,
 * dispatch, and inbox handling. There is no orchestrator agent.
 */
export function registerServe(program: Command): void {
  withConfigOption(
    program
      .command("serve [config]")
      .description("set up (if needed) and start everything: API, engine loop, herdr session, kanban board")
      .option("--port <port>", "port for the HTTP API")
      .option("--agent-kind <kind>", "agent harness stage agents run as")
      .option("--repo-cwd <path>", "repository Faktory dispatches work in")
      .option("--session <name>", "herdr session name")
      .option("--wip <n>", "how many tasks may occupy the actionable lanes")
      .option("--headless", "no herdr session or board — just the API + loop")
      .option("--no-board", "skip the kanban board pane")
      .action((configArg, opts) => runServe(configArg, opts)),
  );

  program
    .command("__provision <config>", { hidden: true })
    .option("--session <name>")
    .option("--port <port>")
    .action(async (slug: string, opts) => {
      const sessionName = opts.session ?? sessionNameFor(slug);
      const client = await waitForSession(sessionName);
      process.env.HERDR_SOCKET_PATH = sessionSocketPath(sessionName);
      const { db } = requireInstance(slug);
      const port = Number(opts.port ?? getConfig(db, "port") ?? 4600);
      db.close();
      await bootstrapDetached(client, detachedWorkbench(slug, port));
    });
}

interface ServeOpts {
  config?: string;
  instance?: string;
  port?: string;
  agentKind?: string;
  repoCwd?: string;
  session?: string;
  wip?: string;
  headless?: boolean;
  board: boolean; // commander sets `board: false` for --no-board
}

/** Build the loop config that binds agents' `faktory report` command + WIP. */
function loopConfig(engine: Engine, slug: string, port: number, wip: number) {
  return {
    wip,
    stallTimeoutMs: DEFAULT_STALL_MS,
    reportCommandFor: (task: Task, stage: Stage, agentName: string) =>
      `${FAKTORY_BIN} report ${task.id} --config ${slug} --port ${port} --sender ${agentName} --stage ${stage}`,
  };
}

async function runServe(configArg: string | undefined, opts: ServeOpts): Promise<void> {
  const slug = await resolveServeConfig(configArg ?? selectedConfig(opts));
  let ctx = requireInstance(slug);
  if (!hasSource(ctx)) {
    console.log(`config "${slug}" has no source yet — finishing setup`);
    ctx.db.close();
    await runSetup({ name: slug });
    ctx = requireInstance(slug);
  }
  const agentKind = opts.agentKind ?? getConfig(ctx.db, "agentKind") ?? "pi";
  const port = Number(opts.port ?? getConfig(ctx.db, "port") ?? 4600);
  // Guard against a non-numeric --wip / stored config: a NaN WIP would make the
  // loop's `count >= wip` cap always false and flood the lanes with the whole
  // backlog. Fall back to the default on anything that isn't a valid count.
  const wipRaw = Number(opts.wip ?? getConfig(ctx.db, "wip") ?? DEFAULT_WIP);
  const wip = Number.isInteger(wipRaw) && wipRaw >= 0 ? wipRaw : DEFAULT_WIP;

  if (!opts.headless) {
    await ensureDependencies([herdrDependency(), harnessDependency(agentKind)]);
  }

  // Faktory owns herdr. From a plain terminal, serve itself moves into a pane
  // inside the dedicated session (so it survives window closes) and THIS
  // terminal attaches to the session as the herdr client.
  const insidePane = !!(process.env.HERDR_PANE_ID && process.env.HERDR_SOCKET_PATH);
  if (!insidePane && !opts.headless) {
    const sessionName = opts.session ?? getConfig(ctx.db, "herdrSession") ?? sessionNameFor(slug);
    ctx.db.close();
    await launchAndAttach(slug, sessionName, port);
    return;
  }

  const engine = buildEngine(ctx);
  let herdr: HerdrClient | undefined;
  try {
    herdr = HerdrClient.fromEnv();
  } catch {
    console.warn("warning: no herdr session — the engine loop is disabled (API-only, view mode)");
  }

  const server = createApiServer({ engine, prefix: ctx.ref.prefix });
  server.listen(port, "127.0.0.1", async () => {
    console.log(`faktory ${ctx.ref.prefix} on http://127.0.0.1:${port}`);

    // The engine loop: this process is the deterministic coordinator.
    if (herdr) {
      const repoCwd = opts.repoCwd ?? getConfig(ctx.db, "repoCwd") ?? REPO_ROOT;
      const dispatcher = new HerdrDispatcher(herdr, ctx.ref.prefix, { agentKind, repoCwd });
      const loop = new Loop(engine, dispatcher, loopConfig(engine, slug, port, wip));
      const tick = async () => {
        try {
          await loop.tick();
        } catch (e) {
          console.warn(`loop tick failed: ${(e as Error).message}`);
        }
      };
      await tick();
      setInterval(tick, DEFAULT_TICK_MS).unref();
      console.log(`engine loop running (wip ${wip})`);
    }

    const fromPaneId = process.env.HERDR_PANE_ID;
    if (opts.headless || !herdr || !fromPaneId) return;
    try {
      const result = await bootstrapWorkbench(herdr, {
        instance: ctx.ref.slug,
        prefix: ctx.ref.prefix,
        port,
        repoCwd: REPO_ROOT,
        faktoryBin: FAKTORY_BIN,
        fromPaneId,
        serveTab: true,
        board: opts.board,
      });
      if (result.alreadyBootstrapped)
        console.log(`workspace ${result.workspaceId} already bootstrapped — tabs preserved`);
      if (result.boardPaneId) console.log(`board tab (pane ${result.boardPaneId})`);
    } catch (e) {
      console.warn(`warning: workbench bootstrap failed: ${(e as Error).message}`);
    }
  });
}
