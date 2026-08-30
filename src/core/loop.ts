import type { Engine } from "./engine.ts";
import { canHandoff, isWorking, roleFor } from "./lifecycle.ts";
import { rolePrompts, type RolePrompts } from "./stages.ts";
import type { InboxMessage, Phase, Role, Task } from "./types.ts";
import { PHASES } from "./types.ts";

/**
 * The programmatic engine loop — the deterministic coordinator that replaces
 * the old prompt-driven orchestrator agent. It is the single owner of task
 * state: it selects on the inbox, validates each message, and serially applies
 * mutations (transitions, annotations, dispatch, archival). Agents are like
 * goroutines with no shared memory; the inbox is the channel; this loop is the
 * coordinator. No prompt, no judgement — just policy encoded as code.
 *
 * Every role is interactive: agents converse with the human in their herdr
 * tab, and herdr itself surfaces an agent that is asking for input. The loop
 * therefore never second-guesses a session — no nudging, no stall detection,
 * no declaring an agent dead. A task moves only on a handoff (or a human).
 *
 * It reaches herdr only through the `Dispatcher` port, so the domain stays pure
 * (the herdr implementation is injected — see src/herdr/loop-dispatcher.ts).
 */

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
  /**
   * Provision the task space + role tab, start the agent with `prompts.system`
   * as its system prompt (where the harness supports one), and send
   * `prompts.kickoff` as the first message.
   */
  dispatchStage(task: Task, role: Role, prompts: RolePrompts): Promise<StageDispatchResult>;
  /** Close the task's herdr space (used on archive). */
  archiveTaskSpace(task: Task): Promise<void>;
  /**
   * The live herdr inventory (existing workspace ids and agent names), used to
   * verify that recorded task assignments still point at real things.
   */
  inventory(): Promise<{ workspaceIds: string[]; agentNames: string[] }>;
}

export interface LoopConfig {
  /** The `faktory report ...` prefix agents call to reach the inbox API. */
  reportCommandFor: (task: Task, role: Role, agentName: string) => string;
  /** Agent-facing `faktory task` commands, scoped to this config. */
  taskCliFor?: (task: Task) => { show: string; list: string };
}

export class Loop {
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
    await this.repairAssignments();
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
        });
        await this.mirror(task, msg, to as Phase);
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

  /**
   * Auto-repair stale herdr assignments. A task records where it is worked
   * (workspaceId, agentName); after a session restart or a hand-closed
   * workspace those coordinates can point at nothing, leaving the task
   * "being worked" forever — or dispatch failing against a dead workspace.
   * When a recorded coordinate cannot be identified in herdr's live
   * inventory, it is cleared so the next pass provisions a fresh session
   * (with the papertrail). Existence only, never liveness: a quiet or busy
   * session that still exists is never touched — herdr owns interactivity.
   * When herdr itself is unreachable, nothing can be identified either way,
   * so nothing is repaired.
   */
  private async repairAssignments(): Promise<void> {
    const tasks = this.engine.tasks.list().filter((t) => roleFor(t.phase) && (t.workspaceId || t.agentName));
    if (tasks.length === 0) return;
    let inventory: { workspaceIds: string[]; agentNames: string[] };
    try {
      inventory = await this.dispatcher.inventory();
    } catch {
      return; // herdr unreachable — cannot tell "gone" from "can't ask"
    }
    const workspaces = new Set(inventory.workspaceIds);
    const agents = new Set(inventory.agentNames);
    for (const task of tasks) {
      const gone: string[] = [];
      const patch: Record<string, string | null> = {};
      if (task.workspaceId && !workspaces.has(task.workspaceId)) {
        patch.workspaceId = null;
        patch.paneId = null;
        gone.push(`workspace ${task.workspaceId}`);
      }
      if (task.agentName && !agents.has(task.agentName)) {
        patch.agentName = null;
        patch.stage = null;
        patch.paneId = null;
        patch.dispatchedAt = null;
        gone.push(`agent ${task.agentName}`);
      }
      if (!gone.length) continue;
      this.engine.tasks.update(task.id, patch);
      this.engine.feed.append({
        taskId: task.id,
        kind: "repair",
        actor: "engine",
        message: `auto-repaired stale herdr assignment: ${gone.join(", ")} no longer exists — reprovisioning`,
      });
    }
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
    // The unblocking session's context lives in the audit trail: the
    // transition that moved the task into blocked carries the reason (its
    // note) and the lane it left (its `from`). Everything else the agent
    // needs it fetches itself (`task show --json`).
    const blocking = role === "unblock" ? this.engine.tasks.events(task.id).findLast((e) => e.to === "blocked") : undefined;
    const prompts = rolePrompts(role, {
      task,
      reason: blocking?.note ?? null,
      cameFrom: blocking?.from ?? null,
      reportCommand: this.cfg.reportCommandFor(task, role, agentName),
      taskCli: this.cfg.taskCliFor?.(task),
    });
    try {
      const result = await this.dispatcher.dispatchStage(task, role, prompts);
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
      // Dispatch failures are transient (herdr connectivity): surface on the
      // feed and leave the task waiting — the next pass retries.
      this.engine.feed.append({
        taskId: task.id,
        kind: "error",
        actor: "engine",
        message: `dispatch ${role} failed (will retry): ${(e as Error).message}`,
      });
    }
  }
}
