import { Command } from "commander";
import { getConfig } from "../../core/db.ts";
import { requireInstance } from "../context.ts";
import { selectedConfig, withConfigOption } from "../options.ts";

/**
 * `faktory report` — the agent-facing wrapper over the inbox API. A dispatched
 * stage agent calls this to talk back to the engine loop (the one channel; the
 * agent never mutates state directly). It just POSTs a typed message to
 * `/api/tasks/:id/inbox`; the loop validates and applies it.
 *
 * The loop bakes `--config`, `--port`, `--sender`, and `--stage` into the
 * command it hands the agent, so the agent only supplies `--type` (+ note/data).
 */
export function registerReport(program: Command): void {
  withConfigOption(
    program
      .command("report <id>")
      .description("send a typed message to the Faktory inbox (agent → loop channel)")
      .requiredOption("--type <type>", "handoff | note")
      .option("--note <text>", "human-readable summary / handoff payload")
      .option("--to <lane>", "target lane for a handoff message (folded into data.to)")
      .option("--data <json>", "structured handoff data as a JSON object")
      .option("--sender <agent>", "herdr agent name (origin check)")
      .option("--stage <stage>", "pipeline stage the message is about")
      .option("--port <port>", "port the serve API listens on"),
  ).action(async (idRaw: string, opts) => {
    const { db } = requireInstance(selectedConfig(opts));
    const port = Number(opts.port ?? getConfig(db, "port") ?? 4600);
    db.close();
    let data: Record<string, unknown> | undefined;
    if (opts.data) {
      try {
        data = JSON.parse(opts.data);
      } catch {
        throw new Error(`--data must be valid JSON: ${opts.data}`);
      }
    }
    if (opts.to) data = { ...data, to: opts.to };
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${Number(idRaw)}/inbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: opts.type,
        note: opts.note ?? null,
        data: data ?? null,
        sender: opts.sender ?? null,
        stage: opts.stage ?? null,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`report failed (${res.status}): ${body.error ?? "unknown"}`);
    console.log(`reported ${opts.type} on task #${idRaw}`);
  });
}
