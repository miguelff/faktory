import { Command } from "commander";
import { getConfig } from "../../core/db.ts";
import { createApiServer } from "../../api/server.ts";
import { HerdrClient } from "../../herdr/client.ts";
import { bootstrapDetached, bootstrapWorkbench } from "../../herdr/bootstrap.ts";
import { sessionSocketPath, waitForSession } from "../../herdr/session.ts";
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

/**
 * `serve` is the single readiness gate that makes Faktory usable: resolve (or
 * set up) a config, ensure every external tool exists, then either move into a
 * herdr pane and attach the current terminal, or (inside a pane / headless)
 * start the API + web board and bootstrap the workbench.
 *
 * `__provision` is the hidden companion: pane setup for a cold-started session,
 * run detached by the launcher.
 */
export function registerServe(program: Command): void {
  withConfigOption(
    program
      .command("serve [config]")
      .description("set up (if needed) and start everything: API, web board, herdr session, TUI, orchestrator")
      .option("--port <port>", "port for the web board / API")
      .option("--agent-kind <kind>", "agent harness for /kickoff")
      .option("--repo-cwd <path>", "repository Faktory dispatches work in")
      .option("--session <name>", "herdr session name")
      .option("--headless", "no herdr session, TUI, or orchestrator — just the API")
      .option("--no-tui", "skip the TUI pane")
      .option("--no-agent", "skip the orchestrator agent pane")
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
      const agentKind = getConfig(db, "agentKind") ?? "pi";
      const orchestratorKind = getConfig(db, "orchestratorKind") ?? agentKind;
      db.close();
      await bootstrapDetached(client, detachedWorkbench(slug, port, orchestratorKind));
    });
}

interface ServeOpts {
  config?: string;
  instance?: string;
  port?: string;
  agentKind?: string;
  repoCwd?: string;
  session?: string;
  headless?: boolean;
  tui: boolean; // commander sets `tui: false` for --no-tui
  agent: boolean; // commander sets `agent: false` for --no-agent
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
  const orchestratorKind = getConfig(ctx.db, "orchestratorKind") ?? agentKind;
  const port = Number(opts.port ?? getConfig(ctx.db, "port") ?? 4600);

  // serve is the single readiness gate: every external tool the workbench needs
  // (herdr, task harness, orchestrator harness) is checked and installed here,
  // never by the individual components it bootstraps.
  if (!opts.headless) {
    await ensureDependencies([herdrDependency(), harnessDependency(agentKind), harnessDependency(orchestratorKind)]);
  }

  // Faktory owns herdr. From a plain terminal, serve itself moves into a pane
  // inside the dedicated session (so it survives window closes) and THIS
  // terminal attaches to the session as the herdr client.
  const insidePane = !!(process.env.HERDR_PANE_ID && process.env.HERDR_SOCKET_PATH);
  if (!insidePane && !opts.headless) {
    const sessionName = opts.session ?? getConfig(ctx.db, "herdrSession") ?? sessionNameFor(slug);
    ctx.db.close();
    await launchAndAttach(slug, sessionName, port, orchestratorKind);
    return;
  }

  const engine = buildEngine(ctx);
  let herdr: HerdrClient | undefined;
  try {
    herdr = HerdrClient.fromEnv();
  } catch {
    console.warn("warning: no herdr session — dispatch disabled");
  }
  const server = createApiServer({
    engine,
    prefix: ctx.ref.prefix,
    herdr,
    dispatchDefaults: {
      agentKind,
      repoCwd: opts.repoCwd ?? getConfig(ctx.db, "repoCwd") ?? undefined,
    },
  });
  server.listen(port, "127.0.0.1", async () => {
    console.log(`faktory ${ctx.ref.prefix} on http://127.0.0.1:${port}`);
    const fromPaneId = process.env.HERDR_PANE_ID;
    if (opts.headless || !herdr || !fromPaneId) return;
    try {
      const result = await bootstrapWorkbench(herdr, {
        instance: ctx.ref.slug,
        prefix: ctx.ref.prefix,
        port,
        repoCwd: REPO_ROOT,
        faktoryBin: FAKTORY_BIN,
        agentKind: orchestratorKind,
        fromPaneId,
        serveTab: true,
        tui: opts.tui,
        agent: opts.agent,
      });
      if (result.alreadyBootstrapped)
        console.log(`workspace ${result.workspaceId} already bootstrapped — tabs preserved`);
      if (result.tuiPaneId) console.log(`tui tab (pane ${result.tuiPaneId})`);
      if (result.agentName)
        console.log(
          result.agentAlreadyRunning
            ? `orchestrator ${result.agentName} already running`
            : `orchestrator ${result.agentName} (${orchestratorKind}) started in its own tab (pane ${result.agentPaneId})`,
        );
    } catch (e) {
      console.warn(`warning: workbench bootstrap failed: ${(e as Error).message}`);
    }
  });
}
