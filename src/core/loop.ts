import type { Engine } from "./engine.ts";
import { canHandoff, isInteractive, isWaiting, isWorking, roleFor } from "./lifecycle.ts";
import { rolePrompt } from "./stages.ts";
import type { InboxMessage, Phase, Role, Stage, Task } from "./types.ts";
import { PHASES } from "./types.ts";

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
  /** Deterministic name of the agent that runs `role` of a task. */
  agentNameFor(taskId: number, role: Role): string;
  /** Provision the task space + role tab, start the agent, prompt it. */
  dispatchStage(task: Task, role: Role, prompt: string): Promise<StageDispatchResult>;
  /** Close the task's herdr space (used on archive). */
  archiveTaskSpace(task: Task): Promise<void>;
  /** Current status of a named agent (safety-net reconciliation). */
  agentStatus(agentName: string): Promise<AgentStatus>;
  /** Nudge a quiet agent to report through the inbox. */
  nudge(agentName: string, text: string): Promise<void>;
  /** Show the human a desktop notification ("your turn", stall warnings). */
  notify(title: string, body: string): Promise<void>;
}

export interface LoopConfig {
  /** The `faktory report ...` prefix agents call to reach the inbox API. */
  reportCommandFor: (task: Task, role: Role, agentName: string) => string;
  /** How long a quiet, un-reported agent may sit before it is flagged stalled. */
  stallTimeoutMs: number;
}

export class Loop {
  /** agentName → first time it was seen quiet without a message (for stall timeout). */
  private quietSince = new Map<string, number>();
  private nudged = new Set<string>();
  private warned = new Set<string>();

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
    await this.reapArchived();
    await this.maintainDispatch();
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

    // Origin check. A handoff must come from the task's *current dispatched*
    // agent — a verifiable, non-null sender that matches, on a task that is
    // actually being worked. This closes two holes: an unsigned message being
    // trusted, and a stray/duplicate handoff walking a task through lanes
    // after the agent was detached (agentName cleared) with no work done.
    const stateChanging = msg.type === "handoff";
    if (stateChanging) {
      if (!isWorking(task) || !task.agentName || msg.sender !== task.agentName) {
        return this.reject(msg, "origin");
      }
    } else if (task.agentName && msg.sender && msg.sender !== task.agentName) {
      return this.reject(msg, "sender-mismatch");
    }

    switch (msg.type) {
      case "note": {
        // An interactive agent declares "your turn": a note with
        // data.awaiting = "human" flags the task on the board and notifies the
        // human. Any other note means the agent is active again — unflag.
        if ((msg.data as Record<string, unknown> | null)?.awaiting === "human") {
          this.engine.tasks.update(task.id, { attentionAt: new Date(this.now()).toISOString() });
          this.engine.feed.append({
            taskId: task.id,
            kind: "inbox",
            actor: `agent:${msg.sender ?? "?"}`,
            message: `waiting on you: ${msg.note ?? ""}`.trim(),
          });
          await this.notify(task, msg.note ?? "an agent is waiting on you");
        } else if (task.attentionAt) {
          this.engine.tasks.update(task.id, { attentionAt: null });
        }
        await this.mirror(task, msg, null);
        return this.resolve(msg, "applied");
      }

      case "handoff": {
        const to = (msg.data as Record<string, unknown> | null)?.to;
        if (typeof to !== "string" || !(PHASES as readonly string[]).includes(to)) {
          return this.reject(msg, "handoff-missing-target");
        }
        if (!canHandoff(task.phase, to as Phase)) return this.reject(msg, `illegal(${task.phase}->${to})`);
        // The role finished (or is routing elsewhere): move the task and detach
        // the agent so the lane is free. Where it came from stays in the audit
        // trail — the unblocking session reads its context from there.
        await this.engine.transition(task.id, to as Phase, `agent:${msg.sender ?? "loop"}`, msg.note ?? "handoff", {
          stage: null,
          agentName: null,
          paneId: null,
          dispatchedAt: null,
          attentionAt: null,
        });
        await this.mirror(task, msg, to as Phase);
        if (msg.sender) this.forget(msg.sender);
        return this.resolve(msg, "applied");
      }
    }
  }

  /**
   * Mirror an applied message to the datasource as a `<handoff from to>` marker
   * comment — the task's papertrail. Best-effort: the inbox row already
   * preserves the trail locally.
   */
  private async mirror(task: Task, msg: InboxMessage, to: Phase | null): Promise<void> {
    if (!msg.note && !msg.data && !to) return;
    const { to: _target, ...data } = (msg.data as Record<string, string | number | boolean> | null) ?? {};
    try {
      await this.engine.comment(task.id, {
        from: msg.stage ?? task.stage ?? task.phase,
        to,
        note: msg.note,
        data: { agent: msg.sender, ...data },
      });
    } catch {
      /* best-effort */
    }
    this.engine.feed.append({
      taskId: task.id,
      kind: "annotation",
      actor: `agent:${msg.sender ?? "?"}`,
      message: `${to ? `handoff → ${to}: ` : ""}${msg.note ?? "(handoff data)"}`,
    });
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
      // Only reconcile role-bearing tasks that are supposed to be being worked.
      const role = roleFor(task.phase);
      if (!role || !isWorking(task) || !task.agentName) continue;
      const status = await this.dispatcher.agentStatus(task.agentName);
      if (status === "working") {
        this.forget(task.agentName);
        continue;
      }
      if (status === "blocked") {
        // herdr blocked (permission/tool prompt) → needs a human. An
        // interactive session already has the human in its tab, so it is only
        // flagged; a pipeline lane is routed to blocked.
        if (isInteractive(role)) await this.warnOnce(task, `${task.agentName} is blocked in herdr — answer in its tab`);
        else await this.block(task, `agent ${task.agentName} is blocked in herdr`);
        continue;
      }
      // An agent that vanished from herdr is a hard stall. An interactive
      // session is detached so a fresh one opens (with the trail); a pipeline
      // lane is routed to blocked for a human.
      if (status === "absent") {
        if (isInteractive(role)) await this.detach(task, `stalled: ${task.agentName} is gone from herdr — reopening`);
        else await this.block(task, `stalled: ${task.agentName} is gone from herdr`);
        continue;
      }
      // Quiet (no completion — never inferred from silence). Two flavours:
      //  - `idle`: possibly a live conversation (an interactive agent
      //    legitimately sits idle waiting for the human). Nudge once, then only
      //    *flag* it — never tear down a possibly-active session.
      //  - `done`/`unknown`: the agent process ended (or is unrecognisable)
      //    without reporting. Nudge once, then reclaim the lane after the
      //    timeout (interactive → reopen; pipeline → blocked), or the lane
      //    leaks a dead session forever.
      const first = this.quietSince.get(task.agentName) ?? this.now();
      this.quietSince.set(task.agentName, first);
      if (!this.nudged.has(task.agentName)) {
        this.nudged.add(task.agentName);
        await this.dispatcher.nudge(
          task.agentName,
          "You appear to have gone quiet. If your stage is done send a `handoff` inbox message with `--to <next lane>`; if you need a human, `--to blocked`.",
        );
        this.engine.feed.append({ taskId: task.id, kind: "stall", actor: "engine", message: `nudged ${task.agentName} to report` });
        continue;
      }
      if (this.now() - first < this.cfg.stallTimeoutMs) continue;
      if (status === "idle") {
        await this.warnOnce(task, `${task.agentName} has been quiet without reporting — may need attention (check its tab)`);
      } else if (isInteractive(role)) {
        // done | unknown: the session ended without reporting — reopen it.
        await this.detach(task, `stalled: ${task.agentName} ended without reporting — reopening`);
      } else {
        // done | unknown: ended without reporting — reclaim the lane.
        await this.block(task, `stalled: ${task.agentName} ended without reporting`);
      }
    }
  }

  /** Flag a task's agent on the feed once (until it reports or is replaced), and notify the human. */
  private async warnOnce(task: Task, message: string): Promise<void> {
    if (!task.agentName || this.warned.has(task.agentName)) return;
    this.warned.add(task.agentName);
    this.engine.feed.append({ taskId: task.id, kind: "stall", actor: "engine", message });
    await this.notify(task, message);
  }

  /** Best-effort desktop notification — the board and feed carry the same signal. */
  private async notify(task: Task, body: string): Promise<void> {
    try {
      await this.dispatcher.notify(`faktory #${task.id} ${task.title}`, body);
    } catch {
      /* best-effort */
    }
  }

  /** Detach a dead interactive session so a fresh one opens on the next pass. */
  private async detach(task: Task, reason: string): Promise<void> {
    if (task.agentName) this.forget(task.agentName);
    this.engine.tasks.update(task.id, { agentName: null, stage: null, paneId: null, dispatchedAt: null, attentionAt: null });
    this.engine.feed.append({ taskId: task.id, kind: "stall", actor: "engine", message: reason });
  }

  private forget(agentName: string): void {
    this.quietSince.delete(agentName);
    this.nudged.delete(agentName);
    this.warned.delete(agentName);
  }

  /**
   * Close the herdr space of any archived task that still has one — the loop
   * archives conversations when a task leaves the board. Idempotent: the space
   * id is cleared once closed.
   */
  private async reapArchived(): Promise<void> {
    for (const task of this.engine.tasks.list("archived")) {
      if (!task.workspaceId) continue;
      try {
        await this.dispatcher.archiveTaskSpace(task);
      } catch (e) {
        this.engine.feed.append({ taskId: task.id, kind: "error", actor: "engine", message: `archive failed: ${(e as Error).message}` });
        continue;
      }
      this.engine.tasks.update(task.id, { workspaceId: null, paneId: null, agentName: null, stage: null, dispatchedAt: null });
      this.engine.feed.append({ taskId: task.id, kind: "transition", actor: "engine", message: "archived: closed herdr space" });
    }
  }

  private async block(task: Task, reason: string): Promise<void> {
    if (task.phase === "blocked") return;
    // Shaping never blocks: the session is already interactive with the human,
    // so surface the problem on the feed and leave the task in its lane.
    if (task.phase === "shape") {
      this.engine.feed.append({ taskId: task.id, kind: "stall", actor: "engine", message: `${reason} (shape stays in its lane — check its tab)` });
      return;
    }
    // Detach the agent: a blocked task is no longer being worked. The loop
    // opens an interactive unblocking session for it on the next pass.
    if (task.agentName) this.forget(task.agentName);
    await this.engine.transition(task.id, "blocked", "engine", reason, {
      stage: null,
      agentName: null,
      dispatchedAt: null,
      attentionAt: null,
    });
    this.engine.feed.append({ taskId: task.id, kind: "stall", actor: "engine", message: reason });
  }

  // --- dispatch: keep every waiting task attended --------------------------

  private async maintainDispatch(): Promise<void> {
    // Dispatch the phase's role to any role-bearing task that is waiting
    // (promoted by a human, or routed by a handoff): a stage agent for the
    // pipeline lanes, an interactive unblocking session for blocked. Tasks
    // already being worked are skipped — dispatch is idempotent. The loop
    // never promotes from `backlog`: that move is a human's.
    for (const task of this.engine.tasks.list()) {
      const role = roleFor(task.phase);
      if (role && !isWorking(task)) await this.dispatch(task, role);
    }
  }

  private async dispatch(task: Task, role: Role): Promise<void> {
    const agentName = this.dispatcher.agentNameFor(task.id, role);
    const handoff = this.engine.inbox.forTask(task.id);
    // The unblocking session's context lives in the audit trail: the
    // transition that moved the task into blocked carries the reason (its
    // note) and the lane it left (its `from`).
    const blocking = role === "unblock" ? this.engine.tasks.events(task.id).findLast((e) => e.to === "blocked") : undefined;
    const prompt = rolePrompt(role, {
      task,
      handoff,
      reason: blocking?.note ?? null,
      cameFrom: blocking?.from ?? null,
      reportCommand: this.cfg.reportCommandFor(task, role, agentName),
    });
    try {
      const result = await this.dispatcher.dispatchStage(task, role, prompt);
      this.engine.tasks.update(task.id, {
        workspaceId: result.workspaceId,
        paneId: result.paneId,
        agentName: result.agentName,
        stage: role,
        dispatchedAt: new Date(this.now()).toISOString(),
        branch: result.branch,
      });
      this.engine.tasks.recordStage(task.id, role, { paneId: result.paneId, agentName: result.agentName });
      this.engine.feed.append({
        taskId: task.id,
        kind: "dispatch",
        actor: "engine",
        message: `dispatched ${role} → ${result.agentName}`,
      });
    } catch (e) {
      await this.block(task, `dispatch failed: ${(e as Error).message}`);
    }
  }
}
