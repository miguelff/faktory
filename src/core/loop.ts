import type { Engine } from "./engine.ts";
import { canTransition, STAGE_COMPLETION, isStage, isWaiting, isWorking } from "./lifecycle.ts";
import { stagePrompt } from "./stages.ts";
import type { InboxMessage, Stage, Task } from "./types.ts";

/**
 * The programmatic engine loop — the deterministic coordinator that replaces
 * the old prompt-driven orchestrator agent. It is the single owner of task
 * state: it selects on the inbox, validates each message, and serially applies
 * mutations (transitions, annotations, dispatch, archival). Agents are like
 * goroutines with no shared memory; the inbox is the channel; this loop is the
 * coordinator. No prompt, no judgement — just policy encoded as code.
 *
 * It reaches herdr only through the `Dispatcher` port, so the domain stays pure
 * (the herdr implementation is injected — see src/herdr/loop-dispatcher.ts).
 */

/** herdr agent lifecycle as herdr reports it, plus `absent` (agent gone). */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown" | "absent";

export interface StageDispatchResult {
  workspaceId: string;
  paneId: string;
  agentName: string;
  branch: string;
}

/** The herdr-facing port the loop depends on. */
export interface Dispatcher {
  /** Deterministic name of the agent that runs `stage` of a task. */
  agentNameFor(taskId: number, stage: Stage): string;
  /** Provision the task space + stage tab, start the agent, prompt it. */
  dispatchStage(task: Task, stage: Stage, prompt: string): Promise<StageDispatchResult>;
  /** Close the task's herdr space (used on archive). */
  archiveTaskSpace(task: Task): Promise<void>;
  /** Current status of a named agent (safety-net reconciliation). */
  agentStatus(agentName: string): Promise<AgentStatus>;
  /** Nudge a quiet agent to report through the inbox. */
  nudge(agentName: string, text: string): Promise<void>;
}

export interface LoopConfig {
  /** Single global WIP target: how many tasks may occupy the actionable lanes. */
  wip: number;
  /** The `faktory report ...` prefix agents call to reach the inbox API. */
  reportCommandFor: (task: Task, stage: Stage, agentName: string) => string;
  /** How long a quiet, un-reported agent may sit before it is flagged stalled. */
  stallTimeoutMs: number;
}

export class Loop {
  /** agentName → first time it was seen quiet without a message (for stall timeout). */
  private quietSince = new Map<string, number>();
  private nudged = new Set<string>();

  constructor(
    private readonly engine: Engine,
    private readonly dispatcher: Dispatcher,
    private readonly cfg: LoopConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** One deterministic pass. Safe to call on an interval. */
  async tick(): Promise<void> {
    await this.engine.syncCandidates();
    await this.drainInbox();
    await this.reconcileAgents();
    await this.maintainWip();
  }

  // --- inbox: the one channel agents use to talk back -----------------------

  private async drainInbox(): Promise<void> {
    for (const msg of this.engine.inbox.pending()) {
      try {
        await this.applyMessage(msg);
      } catch (e) {
        this.engine.inbox.resolve(msg.id, `rejected:error`);
        this.engine.feed.append({
          taskId: msg.taskId,
          kind: "error",
          actor: `agent:${msg.sender ?? "?"}`,
          message: `inbox message failed: ${(e as Error).message}`,
        });
      }
    }
  }

  /** Validate a message's origin + legality, then apply it. */
  private async applyMessage(msg: InboxMessage): Promise<void> {
    const task = this.engine.tasks.byId(msg.taskId);
    if (!task) return this.reject(msg, "no-task");

    // Origin check: the sender must be the task's current stage agent.
    if (task.agentName && msg.sender && msg.sender !== task.agentName) {
      return this.reject(msg, "sender-mismatch");
    }

    // Persist the handoff annotation for the trail (best-effort on the source).
    if (msg.note || msg.data) {
      try {
        await this.engine.comment(msg.taskId, {
          note: msg.note,
          data: (msg.data as Record<string, string | number | boolean> | null) ?? undefined,
        });
      } catch {
        /* the inbox row already preserves the trail; source comment is best-effort */
      }
      this.engine.feed.append({
        taskId: msg.taskId,
        kind: "annotation",
        actor: `agent:${msg.sender ?? "?"}`,
        message: msg.note ?? "(handoff data)",
      });
    }

    switch (msg.type) {
      case "note":
        return this.resolve(msg, "applied");

      case "needs_human": {
        if (task.phase !== "blocked") {
          await this.engine.transition(task.id, "blocked", `agent:${msg.sender ?? "loop"}`, msg.note ?? "needs a human", {
            resumePhase: task.phase,
            stage: null,
            agentName: null,
            dispatchedAt: null,
          });
        }
        this.engine.feed.append({
          taskId: task.id,
          kind: "inbox",
          actor: `agent:${msg.sender ?? "?"}`,
          message: `needs human: ${msg.note ?? ""}`.trim(),
        });
        return this.resolve(msg, "surfaced");
      }

      case "completed": {
        if (!isStage(task.phase)) return this.reject(msg, `not-in-a-stage(${task.phase})`);
        const next = STAGE_COMPLETION[task.phase];
        if (!canTransition(task.phase, next)) return this.reject(msg, `illegal(${task.phase}->${next})`);
        // Stage finished: advance and detach the agent so the lane is free.
        await this.engine.transition(task.id, next, `agent:${msg.sender ?? "loop"}`, msg.note ?? "stage completed", {
          stage: null,
          agentName: null,
          paneId: null,
          dispatchedAt: null,
        });
        this.quietSince.delete(msg.sender ?? "");
        this.nudged.delete(msg.sender ?? "");
        return this.resolve(msg, "applied");
      }
    }
  }

  private reject(msg: InboxMessage, reason: string): void {
    this.engine.inbox.resolve(msg.id, `rejected:${reason}`);
    this.engine.feed.append({
      taskId: msg.taskId,
      kind: "inbox",
      actor: `agent:${msg.sender ?? "?"}`,
      message: `rejected (${reason})`,
    });
  }

  private resolve(msg: InboxMessage, outcome: string): void {
    this.engine.inbox.resolve(msg.id, outcome);
  }

  // --- safety net: reconcile herdr agent state against the inbox ------------

  private async reconcileAgents(): Promise<void> {
    for (const task of this.engine.tasks.list()) {
      // Only reconcile lane tasks that are supposed to be being worked.
      if (!isWorking(task) || !isStage(task.phase) || !task.agentName || !task.stage) continue;
      const status = await this.dispatcher.agentStatus(task.agentName);
      if (status === "working") {
        this.quietSince.delete(task.agentName);
        continue;
      }
      if (status === "blocked") {
        // herdr blocked (permission/tool prompt) → needs human, surface regardless.
        await this.block(task, `agent ${task.agentName} is blocked in herdr`);
        continue;
      }
      // idle | done | unknown | absent with no inbox message = quiet. The loop
      // never reads completion from silence: nudge once, then flag after a
      // timeout. (A real completion arrives via the inbox and clears the stage.)
      const first = this.quietSince.get(task.agentName) ?? this.now();
      this.quietSince.set(task.agentName, first);
      if (!this.nudged.has(task.agentName) && status !== "absent") {
        this.nudged.add(task.agentName);
        await this.dispatcher.nudge(
          task.agentName,
          "You appear to have gone quiet. Send your terminal inbox message (completed or needs_human) now.",
        );
        this.engine.feed.append({
          taskId: task.id,
          kind: "stall",
          actor: "engine",
          message: `nudged ${task.agentName} to report`,
        });
        continue;
      }
      if (status === "absent" || this.now() - first >= this.cfg.stallTimeoutMs) {
        await this.block(task, `stalled: ${task.agentName} went quiet without reporting`);
        this.quietSince.delete(task.agentName);
        this.nudged.delete(task.agentName);
      }
    }
  }

  private async block(task: Task, reason: string): Promise<void> {
    if (task.phase === "blocked") return;
    // Detach the agent: a blocked task is no longer being worked.
    await this.engine.transition(task.id, "blocked", "engine", reason, {
      resumePhase: task.phase,
      stage: null,
      agentName: null,
      dispatchedAt: null,
    });
    this.engine.feed.append({ taskId: task.id, kind: "stall", actor: "engine", message: reason });
  }

  // --- WIP: keep the actionable lanes fed ----------------------------------

  private async maintainWip(): Promise<void> {
    // Dispatch a stage agent for any actionable task that is waiting (freshly
    // promoted, or advanced into to_execute/to_review by a completion). Tasks
    // already being worked are skipped — dispatch is idempotent.
    for (const task of this.engine.tasks.list()) {
      if (isWaiting(task)) await this.dispatch(task, task.phase as Stage);
    }

    // Promote from the backlog, highest priority first, until WIP is reached.
    const actionable = () => this.engine.tasks.list().filter((t) => isStage(t.phase)).length;
    const backlog = this.engine.tasks
      .list("backlog")
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id - b.id);
    for (const task of backlog) {
      if (actionable() >= this.cfg.wip) break;
      try {
        await this.engine.transition(task.id, "to_shape", "engine", "promoted from backlog");
      } catch {
        // ClaimLostError (or an illegal move) — skip; the engine already logged it.
        continue;
      }
      const promoted = this.engine.tasks.byId(task.id);
      if (promoted && promoted.phase === "to_shape") await this.dispatch(promoted, "to_shape");
    }
  }

  private async dispatch(task: Task, stage: Stage): Promise<void> {
    const agentName = this.dispatcher.agentNameFor(task.id, stage);
    const handoff = this.engine.inbox.forTask(task.id);
    const prompt = stagePrompt(stage, {
      task,
      handoff,
      reportCommand: this.cfg.reportCommandFor(task, stage, agentName),
    });
    try {
      const result = await this.dispatcher.dispatchStage(task, stage, prompt);
      this.engine.tasks.update(task.id, {
        workspaceId: result.workspaceId,
        paneId: result.paneId,
        agentName: result.agentName,
        stage,
        dispatchedAt: new Date(this.now()).toISOString(),
        branch: result.branch,
      });
      this.engine.tasks.recordStage(task.id, stage, { paneId: result.paneId, agentName: result.agentName });
      this.engine.feed.append({
        taskId: task.id,
        kind: "dispatch",
        actor: "engine",
        message: `dispatched ${stage} → ${result.agentName}`,
      });
    } catch (e) {
      await this.block(task, `dispatch failed: ${(e as Error).message}`);
    }
  }
}
