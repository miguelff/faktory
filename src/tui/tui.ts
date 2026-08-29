import { emitKeypressEvents } from "node:readline";
import { execFile } from "node:child_process";
import type { Engine } from "../core/engine.ts";
import { HerdrClient } from "../herdr/client.ts";
import { TRANSITIONS, isStage, isWorking } from "../core/lifecycle.ts";
import { PHASES, type FeedEntry, type Phase, type Task } from "../core/types.ts";

/**
 * Faktory TUI — the local interface: a kanban board of the pipeline plus a live
 * action feed of what the engine loop and agents are doing. Notion is the
 * remote board; this is the terminal one (and the manual-repair console).
 *
 * Follows terminal-ui guidelines: the whole frame is composed off-screen and
 * written in a single write into the alternate screen; lines are overwritten
 * (ESC[K) rather than clearing; colors are semantic (red=blocked, green=done,
 * yellow=in-flight); every mode has an escape route (q / esc / ctrl+c); and it
 * refreshes on a timer so the board tracks the out-of-process loop live.
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

const PHASE_COLOR: Record<Phase, (s: string) => string> = {
  backlog: C.dim,
  shape: C.info,
  execute: C.warn,
  review: C.info,
  release: C.ok,
  done: C.ok,
  blocked: C.err,
  archived: C.dim,
};

const PHASE_LABEL: Record<Phase, string> = {
  backlog: "Backlog",
  shape: "Shape",
  execute: "Execute",
  review: "Review",
  release: "Release",
  done: "Done",
  blocked: "Blocked",
  archived: "Archived",
};

const COL_WIDTH = 22;
const FEED_LINES = 7;
const REFRESH_MS = 1500;

type Mode = "board" | "detail" | "transition";

export class Tui {
  private mode: Mode = "board";
  private col = 0; // index into the visible columns
  private row = 0; // index into the selected column's cards
  private colStart = 0; // horizontal viewport offset
  private showDone = true;
  private showArchived = false;
  private board = new Map<Phase, Task[]>();
  private feed: FeedEntry[] = [];
  private message = "";
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly engine: Engine,
    private readonly prefix: string,
    private readonly out: NodeJS.WriteStream = process.stdout,
  ) {}

  start(): void {
    this.reload();
    this.out.write(ALT_ON);
    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("keypress", (_ch, key) => this.onKey(key));
    process.on("SIGINT", () => this.quit());
    process.on("SIGTERM", () => this.quit());
    // Track the out-of-process engine loop: refresh on a timer.
    this.timer = setInterval(() => {
      if (!this.busy) {
        this.reload();
        this.render();
      }
    }, REFRESH_MS);
    this.timer.unref?.();
    this.render();
  }

  private quit(): void {
    if (this.timer) clearInterval(this.timer);
    this.out.write(ALT_OFF);
    process.exit(0);
  }

  // --- data ----------------------------------------------------------------

  private visiblePhases(): Phase[] {
    return PHASES.filter(
      (p) => (p !== "archived" || this.showArchived) && (p !== "done" || this.showDone),
    );
  }

  private reload(): void {
    const selectedId = this.selected()?.id;
    this.board = new Map(PHASES.map((p) => [p, this.engine.tasks.list(p)]));
    this.feed = this.engine.feed.recent(FEED_LINES);
    // Keep the selection stable across refreshes when the task still exists.
    if (selectedId != null) {
      const phases = this.visiblePhases();
      for (let c = 0; c < phases.length; c++) {
        const i = (this.board.get(phases[c]!) ?? []).findIndex((t) => t.id === selectedId);
        if (i >= 0) {
          this.col = c;
          this.row = i;
          break;
        }
      }
    }
    this.clampCursor();
  }

  private column(phase: Phase): Task[] {
    return this.board.get(phase) ?? [];
  }

  private selected(): Task | undefined {
    const phase = this.visiblePhases()[this.col];
    if (!phase) return undefined;
    return this.column(phase)[this.row];
  }

  private clampCursor(): void {
    const phases = this.visiblePhases();
    this.col = Math.max(0, Math.min(this.col, phases.length - 1));
    const tasks = this.column(phases[this.col] ?? "backlog");
    this.row = Math.max(0, Math.min(this.row, Math.max(tasks.length - 1, 0)));
  }

  // --- input ---------------------------------------------------------------

  private async onKey(key: { name?: string; ctrl?: boolean; sequence?: string }): Promise<void> {
    if (this.busy) return; // input locked during async work; spinner shown
    if (key.ctrl && key.name === "c") return this.quit();

    switch (this.mode) {
      case "board":
        if (key.name === "q" || key.name === "escape") return this.quit();
        if (key.name === "l" || key.name === "right") this.col++;
        if (key.name === "h" || key.name === "left") this.col--;
        if (key.name === "j" || key.name === "down") this.row++;
        if (key.name === "k" || key.name === "up") this.row--;
        if (key.name === "g") this.row = 0;
        if (key.name === "d") this.toggle("done");
        if (key.name === "a") this.toggle("archived");
        if (key.name === "return" && this.selected()) this.mode = "detail";
        if (key.name === "t" && this.selected()) this.mode = "transition";
        if (key.name === "u" && this.selected()) return this.unblock();
        if (key.name === "x" && this.selected()) return this.unclaim();
        if (key.name === "o" && this.selected()) return this.openUrl();
        if (key.name === "w" && this.selected()) return this.gotoSession();
        if (key.name === "s") return this.sync();
        if (key.name === "r") this.refresh("Reloaded");
        this.clampCursor();
        break;
      case "detail":
        if (key.name === "q" || key.name === "escape") this.mode = "board";
        if (key.name === "t") this.mode = "transition";
        if (key.name === "u") return this.unblock();
        if (key.name === "x") return this.unclaim();
        if (key.name === "o") return this.openUrl();
        if (key.name === "w") return this.gotoSession();
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
        // Force-repair to ANY phase via an unambiguous letter map (A..H →
        // PHASES order). First-letter matching can't work: backlog/blocked
        // and release/review collide.
        if (key.sequence && /^[A-H]$/.test(key.sequence)) {
          const phase = PHASES[key.sequence.charCodeAt(0) - 65];
          if (phase) await this.transitionTo(task, phase, true);
        }
        break;
      }
    }
    this.render();
  }

  private toggle(which: "done" | "archived"): void {
    const keep = this.selected()?.id;
    if (which === "done") this.showDone = !this.showDone;
    else this.showArchived = !this.showArchived;
    this.message = which === "done" ? `Done ${this.showDone ? "shown" : "hidden"}` : `Archived ${this.showArchived ? "shown" : "hidden"}`;
    // Re-anchor the selection to the same task if it is still visible.
    const phases = this.visiblePhases();
    if (keep != null) {
      for (let c = 0; c < phases.length; c++) {
        const i = this.column(phases[c]!).findIndex((t) => t.id === keep);
        if (i >= 0) {
          this.col = c;
          this.row = i;
          break;
        }
      }
    }
    this.clampCursor();
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
    this.render();
  }

  /** Unblock a blocked task back to the lane it came from (read from the audit trail). */
  private async unblock(): Promise<void> {
    const task = this.selected();
    if (!task || task.phase !== "blocked") {
      this.message = "only a blocked task can be unblocked";
      return this.render();
    }
    const to = this.engine.tasks.events(task.id).findLast((e) => e.to === "blocked")?.from ?? "backlog";
    await this.withSpinner(`#${task.id} unblock → ${to}`, async () => {
      await this.engine.transition(task.id, to, "tui", "unblocked");
      this.refresh(`#${task.id} unblocked → ${to}`);
    });
    this.render();
  }

  /**
   * Release the claim on a backlog task: the entry becomes discoverable to
   * every instance again. Deliberately a human act from the board — returning
   * a task to backlog (shape rejection, unblock) never releases automatically.
   */
  private async unclaim(): Promise<void> {
    const task = this.selected();
    if (!task || task.phase !== "backlog") {
      this.message = "only a backlog task can be unclaimed";
      return this.render();
    }
    await this.withSpinner(`#${task.id} release claim`, async () => {
      await this.engine.unclaim(task.id);
      this.refresh(`#${task.id} claim released — discoverable to every instance again`);
    });
    this.render();
  }

  /** Open the selected task's datasource item in the browser. */
  private openUrl(): void {
    const task = this.selected();
    if (!task) return;
    execFile(process.platform === "darwin" ? "open" : "xdg-open", [task.url], () => {});
    this.message = `opened ${task.url}`;
    this.render();
  }

  /** Jump to the selected task's herdr session: focus its workspace + tab. */
  private async gotoSession(): Promise<void> {
    const task = this.selected();
    if (!task) return;
    if (!task.workspaceId) {
      this.message = "no herdr session for this task yet";
      return this.render();
    }
    await this.withSpinner(`#${task.id} → herdr session`, async () => {
      const herdr = HerdrClient.fromEnv();
      await herdr.request("workspace.focus", { workspace_id: task.workspaceId });
      if (task.paneId) {
        const info = ((await herdr.request<any>("pane.get", { pane_id: task.paneId })) as any)?.pane ?? {};
        if (info.tab_id) await herdr.request("tab.focus", { tab_id: info.tab_id });
      }
      this.message = `focused ${task.workspaceId} (${task.stage ?? task.phase})`;
    });
    this.render();
  }

  private async transitionTo(task: Task, to: Phase, force: boolean): Promise<void> {
    await this.withSpinner(`#${task.id} → ${to}${force ? " (forced)" : ""}`, async () => {
      if (force) this.engine.tasks.transition(task.id, to, "tui", { force: true, note: "manual repair" });
      else await this.engine.transition(task.id, to, "tui");
      this.refresh(`#${task.id} → ${to}`);
      this.mode = "detail";
    });
    this.render();
  }

  private refresh(msg: string): void {
    this.reload();
    this.message = msg;
  }

  // --- render --------------------------------------------------------------

  private render(): void {
    const rows = this.out.rows ?? 40;
    const cols = this.out.columns ?? 100;
    const lines: string[] = [];

    const counts = PHASES.map((p) => `${PHASE_LABEL[p][0]}${this.column(p).length}`).join(" ");
    lines.push(C.bold(` ⚙ faktory ${C.accent(this.prefix)} `) + C.dim(`— kanban · ${counts}`));
    lines.push(C.dim("─".repeat(Math.min(cols, 120))));

    if (this.mode === "board") this.renderBoard(lines, rows, cols);
    else this.renderDetail(lines, cols);

    const msg = this.busy ? C.warn(this.message) : this.message;
    const frame = HOME + lines.slice(0, rows - 2).map((l) => l + EOL).join("\n") + `\n${EOL}\n ${msg}${EOL}` + EOS;
    this.out.write(frame);
  }

  private renderBoard(lines: string[], rows: number, cols: number): void {
    const phases = this.visiblePhases();
    const perScreen = Math.max(1, Math.floor((cols - 1) / (COL_WIDTH + 1)));
    // Scroll the horizontal viewport so the selected column stays visible.
    if (this.col < this.colStart) this.colStart = this.col;
    if (this.col >= this.colStart + perScreen) this.colStart = this.col - perScreen + 1;
    const shown = phases.slice(this.colStart, this.colStart + perScreen);

    const boardHeight = Math.max(3, rows - FEED_LINES - 7);
    const columns = shown.map((phase, i) =>
      this.buildColumn(phase, this.colStart + i === this.col, boardHeight),
    );
    for (let r = 0; r < boardHeight; r++) {
      lines.push(" " + columns.map((c) => c[r] ?? " ".repeat(COL_WIDTH)).join(" "));
    }
    const more =
      this.colStart + perScreen < phases.length ? C.dim(" → more") : this.colStart > 0 ? C.dim(" ← more") : "";
    lines.push(C.dim("─".repeat(Math.min(cols, 120))) + more);
    lines.push(C.bold(" feed"));
    for (const e of this.feed) lines.push("  " + this.feedLine(e, cols - 4));
    for (let i = this.feed.length; i < FEED_LINES; i++) lines.push("");
    lines.push(
      C.dim(" h/l column · j/k card (? = your turn) · enter detail · t transition · u unblock · x unclaim · w session · o url · s sync · d done · a archived · q quit"),
    );
  }

  /** Build one fixed-width column: a header cell + card cells, padded to height. */
  private buildColumn(phase: Phase, isSelectedCol: boolean, height: number): string[] {
    const color = PHASE_COLOR[phase];
    const out: string[] = [];
    const tasks = this.column(phase);
    // In an actionable lane, show how many cards are actively being worked
    // and how many are waiting on the human.
    const working = isStage(phase) ? tasks.filter(isWorking).length : 0;
    const waitingOnYou = tasks.filter((t) => t.attentionAt).length;
    const header = isStage(phase)
      ? `${PHASE_LABEL[phase]} ${tasks.length} · ${working}●${waitingOnYou ? ` ${waitingOnYou}?` : ""}`
      : `${PHASE_LABEL[phase]} ${tasks.length}`;
    out.push((isSelectedCol ? C.bold : color)(pad(header, COL_WIDTH)));
    const cardRows = height - 1;
    for (let i = 0; i < cardRows; i++) {
      const t = tasks[i];
      if (!t) {
        out.push(" ".repeat(COL_WIDTH));
        continue;
      }
      // ● working · ○ waiting for the loop · ? the agent is waiting on YOU.
      const mark = t.attentionAt ? "? " : isStage(phase) ? (isWorking(t) ? "● " : "○ ") : "";
      const text = pad(`${mark}#${t.id} ${t.title}`, COL_WIDTH);
      const selected = isSelectedCol && i === this.row;
      out.push(selected ? C.inv(text) : color(text));
    }
    // If more cards than fit, mark the overflow on the last row.
    if (tasks.length > cardRows) out[out.length - 1] = color(pad(`  … +${tasks.length - cardRows} more`, COL_WIDTH));
    return out;
  }

  private feedLine(e: FeedEntry, width: number): string {
    const time = (e.at ?? "").slice(11, 19);
    const tag = e.taskId ? `#${e.taskId}` : "·";
    const tone =
      e.kind === "stall" || e.kind === "error"
        ? C.err
        : e.kind === "dispatch"
          ? C.warn
          : e.kind === "transition"
            ? C.info
            : (s: string) => s;
    return C.dim(`${time} `) + tone(truncate(`${tag} ${e.message}`, width - 9));
  }

  private renderDetail(lines: string[], cols: number): void {
    const t = this.selected();
    if (!t) {
      this.mode = "board";
      return this.renderBoard(lines, this.out.rows ?? 40, cols);
    }
    const color = PHASE_COLOR[t.phase];
    lines.push(` ${C.bold(`#${t.id}`)} ${truncate(t.title, cols - 8)}`);
    const activity = isStage(t.phase) ? (isWorking(t) ? C.warn("● working") : C.dim("○ waiting")) : "";
    lines.push(`   phase     ${color(PHASE_LABEL[t.phase])}  ${activity}`);
    if (t.dispatchedAt) lines.push(`   working   since ${t.dispatchedAt.slice(11, 19)} (agent ${t.agentName ?? "—"})`);
    if (t.attentionAt) lines.push(`   waiting   ${C.err(`on you since ${t.attentionAt.slice(11, 19)} — press w to answer`)}`);
    lines.push(`   url       ${C.info(t.url)}`);
    lines.push(`   priority  ${t.priority ?? "—"}`);
    lines.push(`   herdr     ${t.workspaceId ?? "—"} / ${t.paneId ?? "—"} / ${t.agentName ?? "—"}`);
    lines.push(`   branch    ${t.branch ?? "—"}    pr ${t.prUrl ?? "—"}`);
    if (t.error) lines.push(`   error     ${C.err(truncate(t.error, cols - 14))}`);
    lines.push("");
    lines.push(C.bold("   inbox"));
    for (const m of this.engine.inbox.forTask(t.id).slice(-5)) {
      const tone = m.type === "handoff" ? C.ok : C.dim;
      lines.push(C.dim(`   ${m.createdAt.slice(11, 19)} `) + tone(`${m.type}`) + C.dim(` ${truncate(m.note ?? "", cols - 30)}`));
    }
    lines.push("");
    lines.push(C.bold("   history"));
    for (const e of this.engine.tasks.events(t.id).slice(-6)) {
      lines.push(C.dim(`   ${e.at.slice(11, 19)}  ${e.from ?? "·"} → ${e.to}  [${e.actor}] ${e.note ?? ""}`));
    }
    lines.push("");
    if (this.mode === "transition") {
      const legal = TRANSITIONS[t.phase];
      lines.push(C.bold("   transition to:"));
      legal.forEach((p, i) => lines.push(`     ${C.accent(String(i + 1))}  ${PHASE_LABEL[p]}`));
      lines.push("");
      lines.push(C.dim("   force-repair (SHIFT):"));
      lines.push(
        "   " +
          PHASES.map((p, i) => `${C.accent(String.fromCharCode(65 + i))} ${PHASE_LABEL[p]}`).join("  "),
      );
      lines.push(C.dim("   esc back"));
    } else {
      const unblock = t.phase === "blocked" ? " · u unblock" : "";
      const unclaim = t.phase === "backlog" ? " · x unclaim" : "";
      lines.push(C.dim(` t transition${unblock}${unclaim} · w session · o url · esc back · q board`));
    }
  }
}

/** Truncate then pad to exactly `width` visible characters (ANSI applied after). */
function pad(s: string, width: number): string {
  const t = truncate(s, width);
  return t.length >= width ? t : t + " ".repeat(width - t.length);
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}
