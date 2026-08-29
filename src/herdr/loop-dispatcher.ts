import type { AgentStatus, Dispatcher, StageDispatchResult } from "../core/loop.ts";
import type { Role, Task } from "../core/types.ts";
import type { HerdrClient } from "./client.ts";
import { archiveTaskSpace, dispatchStage, stageAgentName, type DispatchOptions } from "./dispatch.ts";

/**
 * Concrete herdr implementation of the loop's `Dispatcher` port. Keeps the
 * domain loop (core/loop.ts) free of any herdr import — it depends only on the
 * interface, this adapter wires it to the socket + CLI mechanics in dispatch.ts.
 */
const KNOWN: readonly AgentStatus[] = ["idle", "working", "blocked", "done"];

export class HerdrDispatcher implements Dispatcher {
  constructor(
    private readonly herdr: HerdrClient,
    private readonly prefix: string,
    private readonly opts: DispatchOptions,
  ) {}

  agentNameFor(taskId: number, role: Role): string {
    return stageAgentName(this.prefix, taskId, role);
  }

  dispatchStage(task: Task, role: Role, prompt: string): Promise<StageDispatchResult> {
    return dispatchStage(this.herdr, task, role, prompt, this.prefix, this.opts);
  }

  archiveTaskSpace(task: Task): Promise<void> {
    return archiveTaskSpace(this.herdr, task);
  }

  async agentStatus(agentName: string): Promise<AgentStatus> {
    const res = await this.herdr.request<any>("agent.list", {});
    const agents: any[] = res?.agents ?? [];
    const found = agents.find((a) => (a.agent_name ?? a.name) === agentName);
    if (!found) return "absent";
    const raw = found.status ?? found.state ?? "unknown";
    return (KNOWN as readonly string[]).includes(raw) ? (raw as AgentStatus) : "unknown";
  }

  async nudge(agentName: string, text: string): Promise<void> {
    await this.herdr.request("agent.prompt", { target: agentName, text });
  }

  async notify(title: string, body: string): Promise<void> {
    await this.herdr.request("notification.show", { title, body, sound: "request" });
  }
}
