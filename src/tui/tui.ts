import { emitKeypressEvents } from "node:readline";
import type { Engine } from "../core/engine.ts";
import { TRANSITIONS } from "../core/lifecycle.ts";
import { PHASES, type Phase, type Task } from "../core/types.ts";

/**
 * Faktory TUI — inspect and repair orchestration state.
 *
 * Follows terminal-ui guidelines: batched single-write rendering into an
 * alternate screen, overwrite instead of clear, immediate input feedback,
 * semantic colors, and escape routes everywhere (q / esc / ctrl+c).
 */
const ESC = "\u001b[";
const ALT_ON = `${ESC}?1049h${ESC}?25l`;
const ALT_OFF = `${ESC}?25h${ESC}?1049l`;
const HOME = `${ESC}H`;
const EOL = `${ESC}K`; // clear to end of line (overwrite, don't clear screen)
const EOS = `${ESC}J`;

const C = {
  dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
  bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
  inv: (s: string) => `${ESC}7m${s}${ESC}27m`,
  ok: (s: string) => `${ESC}32m${s}${ESC}39m`,
  warn: (s: string) => `${ESC}33m${s}${ESC}39m`,
  err: (s: string) => `${ESC}31m${s}${ESC}39m`,
  info: (s: string) => `${ESC}36m${s}${ESC}39m`,
  accent: (s: string) => `${ESC}35m${s}${ESC}39m`,
};

const PHASE_COLOR: Record<string, (s: string) => string> = {
  discovered: C.dim,
  queued: C.info,
  dispatching: C.warn,
  running: C.warn,
  reviewing: C.info,
  blocked: C.err,
  ready_to_deploy: C.ok,
  deploying: C.warn,
  done: C.ok,
  failed: C.err,
  cancelled: C.dim,
};

type Mode = "list" | "detail" | "transition";

export class Tui {
  private mode: Mode = "list";
  private cursor = 0;
  private tasks: Task[] = [];
  private message = "";
  private busy = false;

  constructor(
    private readonly engine: Engine,
    private readonly prefix: string,
    private readonly out: NodeJS.WriteStream = process.stdout,
  ) {}

  start(): void {
    this.tasks = this.engine.tasks.list();
    this.out.write(ALT_ON);
    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("keypress", (_ch, key) => this.onKey(key));
    const cleanup = () => {
      this.out.write(ALT_OFF);
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    this.render();
  }

  private quit(): void {
    this.out.write(ALT_OFF);
    process.exit(0);
  }

  private selected(): Task | undefined {
    return this.tasks[this.cursor];
  }

  private async onKey(key: { name?: string; ctrl?: boolean; sequence?: string }): Promise<void> {
    if (this.busy) return; // input locked during async work; spinner shown
    if (key.ctrl && key.name === "c") return this.quit();

    switch (this.mode) {
      case "list":
        if (key.name === "q" || key.name === "escape") return this.quit();
        if (key.name === "j" || key.name === "down") this.cursor = Math.min(this.cursor + 1, this.tasks.length - 1);
        if (key.name === "k" || key.name === "up") this.cursor = Math.max(this.cursor - 1, 0);
        if (key.name === "g") this.cursor = 0;
        if (key.name === "return" && this.selected()) this.mode = "detail";
        if (key.name === "t" && this.selected()) this.mode = "transition";
        if (key.name === "r") this.refresh("Reloaded");
        if (key.name === "s") await this.sync();
        break;
      case "detail":
        if (key.name === "q" || key.name === "escape") this.mode = "list";
        if (key.name === "t") this.mode = "transition";
        break;
      case "transition": {
        if (key.name === "q" || key.name === "escape") {
          this.mode = "detail";
          break;
        }
        const task = this.selected();
        if (!task) break;
        const legal = TRANSITIONS[task.phase];
        const idx = Number(key.sequence) - 1;
        if (idx >= 0 && idx < legal.length) await this.transitionTo(task, legal[idx]!, false);
        if (key.name === "f") this.message = `force: press the phase letter — ${PHASES.map((p) => `${p[0]}=${p}`).join(" ")}`;
        // force-repair: capital letter selects any phase by first letter
        if (key.sequence && /^[A-Z]$/.test(key.sequence)) {
          const phase = PHASES.find((p) => p.startsWith(key.sequence!.toLowerCase()));
          if (phase) await this.transitionTo(task, phase, true);
        }
        break;
      }
    }
    this.render();
  }

  private async withSpinner(label: string, fn: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.message = `${label}…`;
    this.render();
    try {
      await fn();
    } catch (e) {
      this.message = C.err(`${label} failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async sync(): Promise<void> {
    await this.withSpinner("Syncing", async () => {
      const fresh = await this.engine.syncCandidates();
      this.refresh(fresh.length ? `Discovered ${fresh.length} new task(s)` : "Up to date");
    });
  }

  private async transitionTo(task: Task, to: Phase, force: boolean): Promise<void> {
    await this.withSpinner(`#${task.id} → ${to}${force ? " (forced)" : ""}`, async () => {
      if (force) this.engine.tasks.transition(task.id, to, "tui", { force: true, note: "manual repair" });
      else await this.engine.transition(task.id, to, "tui");
      this.refresh(`#${task.id} → ${to}`);
      this.mode = "detail";
    });
  }

  private refresh(msg: string): void {
    const selectedId = this.selected()?.id;
    this.tasks = this.engine.tasks.list();
    const i = this.tasks.findIndex((t) => t.id === selectedId);
    this.cursor = i >= 0 ? i : Math.min(this.cursor, Math.max(this.tasks.length - 1, 0));
    this.message = msg;
  }

  /** Compose the whole frame off-screen, then write once (render-single-write). */
  private render(): void {
    const rows = this.out.rows ?? 40;
    const cols = this.out.columns ?? 100;
    const lines: string[] = [];

    lines.push(C.bold(` ⚙ faktory ${C.accent(this.prefix)} `) + C.dim(`— ${this.tasks.length} task(s)`));
    lines.push(C.dim("─".repeat(Math.min(cols, 100))));

    if (this.mode === "list") {
      if (!this.tasks.length) {
        lines.push("");
        lines.push(C.dim("  No tasks yet. Press ") + C.bold("s") + C.dim(" to sync candidates from the source."));
      }
      const visible = this.tasks.slice(0, rows - 6);
      for (let i = 0; i < visible.length; i++) {
        const t = visible[i]!;
        const color = PHASE_COLOR[t.phase] ?? ((s: string) => s);
        const line = ` ${String(t.id).padStart(3)}  ${color(t.phase.padEnd(15))} ${truncate(t.title, cols - 30)}`;
        lines.push(i === this.cursor ? C.inv(line.padEnd(Math.min(cols, 100))) : line);
      }
      lines.push("");
      lines.push(C.dim(" j/k move · enter detail · t transition · s sync · r reload · q quit"));
    } else {
      const t = this.selected();
      if (!t) {
        this.mode = "list";
        return this.render();
      }
      const color = PHASE_COLOR[t.phase] ?? ((s: string) => s);
      lines.push(` ${C.bold(`#${t.id}`)} ${truncate(t.title, cols - 8)}`);
      lines.push(`   phase     ${color(t.phase)}`);
      lines.push(`   url       ${C.info(t.url)}`);
      lines.push(`   priority  ${t.priority ?? "—"}`);
      lines.push(`   herdr     ${t.workspaceId ?? "—"} / ${t.paneId ?? "—"} / ${t.agentName ?? "—"}`);
      lines.push(`   branch    ${t.branch ?? "—"}    pr ${t.prUrl ?? "—"}`);
      if (t.error) lines.push(`   error     ${C.err(truncate(t.error, cols - 14))}`);
      lines.push("");
      lines.push(C.bold("   history"));
      for (const e of this.engine.tasks.events(t.id).slice(-8)) {
        lines.push(C.dim(`   ${e.at}  ${e.from ?? "·"} → ${e.to}  [${e.actor}] ${e.note ?? ""}`));
      }
      lines.push("");
      if (this.mode === "transition") {
        const legal = TRANSITIONS[t.phase];
        lines.push(C.bold("   transition to:"));
        legal.forEach((p, i) => lines.push(`     ${C.accent(String(i + 1))}  ${p}`));
        lines.push(C.dim("   or SHIFT+<letter> to force-repair to any phase · esc back"));
      } else {
        lines.push(C.dim(" t transition · esc back · q list"));
      }
    }

    const msg = this.busy ? C.warn(this.message) : this.message;
    const frame =
      HOME + lines.slice(0, rows - 2).map((l) => l + EOL).join("\n") + `\n${EOL}\n ${msg}${EOL}` + EOS;
    this.out.write(frame);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}
