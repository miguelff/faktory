import type { Dispatcher, StageDispatchResult } from "../core/loop.ts";
import type { Role, Task } from "../core/types.ts";
import type { RolePrompts } from "../core/stages.ts";
import type { HerdrClient } from "./client.ts";
import { archiveTaskSpace, dispatchStage, stageAgentName, type DispatchOptions } from "./dispatch.ts";

/**
 * Concrete herdr implementation of the loop's `Dispatcher` port. Keeps the
 * domain loop (core/loop.ts) free of any herdr import — it depends only on the
 * interface, this adapter wires it to the socket + CLI mechanics in dispatch.ts.
 */
export class HerdrDispatcher implements Dispatcher {
  constructor(
    private readonly herdr: HerdrClient,
    private readonly prefix: string,
    private readonly opts: DispatchOptions,
  ) {}

  agentNameFor(taskId: number, role: Role): string {
    return stageAgentName(this.prefix, taskId, role);
  }

  dispatchStage(task: Task, role: Role, prompts: RolePrompts): Promise<StageDispatchResult> {
    return dispatchStage(this.herdr, task, role, prompts, this.prefix, this.opts);
  }

  archiveTaskSpace(task: Task): Promise<void> {
    return archiveTaskSpace(this.herdr, task);
  }

  async inventory(): Promise<{ workspaceIds: string[]; agentNames: string[] }> {
    const [ws, ag] = await Promise.all([
      this.herdr.request<any>("workspace.list", {}),
      this.herdr.request<any>("agent.list", {}),
    ]);
    return {
      workspaceIds: ((ws?.workspaces ?? []) as any[]).map((w) => w.workspace_id ?? w.id).filter(Boolean),
      agentNames: ((ag?.agents ?? []) as any[]).map((a) => a.agent_name ?? a.name).filter(Boolean),
    };
  }
}
