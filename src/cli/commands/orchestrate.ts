import { Command } from "commander";
import { getConfig } from "../../core/db.ts";
import { HerdrClient } from "../../herdr/client.ts";
import { bootstrapDetached, bootstrapWorkbench } from "../../herdr/bootstrap.ts";
import { ensureSession } from "../../herdr/session.ts";
import { FAKTORY_BIN, REPO_ROOT, requireInstance, sessionNameFor } from "../context.ts";
import { selectedConfig, withConfigOption } from "../options.ts";

/** `orchestrate` (re)starts just the orchestrator agent loop against a running serve. */
export function registerOrchestrate(program: Command): void {
  withConfigOption(
    program
      .command("orchestrate")
      .description("(re)start the orchestrator agent loop against a running serve")
      .option("--port <port>", "port the serve API listens on")
      .option("--agent-kind <kind>", "orchestrator agent harness")
      .option("--session <name>", "herdr session name"),
  ).action(async (opts) => {
    const ctx = requireInstance(selectedConfig(opts));
    if (!process.env.HERDR_SOCKET_PATH) {
      const sessionName = opts.session ?? getConfig(ctx.db, "herdrSession") ?? sessionNameFor(ctx.ref.slug);
      const { socketPath } = await ensureSession(sessionName, REPO_ROOT);
      process.env.HERDR_SOCKET_PATH = socketPath;
    }
    const herdr = HerdrClient.fromEnv();
    const fromPaneId = process.env.HERDR_PANE_ID;
    const port = Number(opts.port ?? getConfig(ctx.db, "port") ?? 4600);
    const orchestratorKind =
      opts.agentKind ?? getConfig(ctx.db, "orchestratorKind") ?? getConfig(ctx.db, "agentKind") ?? "pi";
    const workbench = {
      instance: ctx.ref.slug,
      prefix: ctx.ref.prefix,
      port,
      repoCwd: REPO_ROOT,
      faktoryBin: FAKTORY_BIN,
      agentKind: orchestratorKind,
      tui: false,
      agent: true,
    };
    const result = fromPaneId
      ? await bootstrapWorkbench(herdr, { ...workbench, fromPaneId })
      : await bootstrapDetached(herdr, workbench);
    console.log(
      result.agentAlreadyRunning
        ? `orchestrator ${result.agentName} already running`
        : `orchestrator ${result.agentName} (${orchestratorKind}) started in its own tab (pane ${result.agentPaneId}) against http://127.0.0.1:${port}`,
    );
  });
}
