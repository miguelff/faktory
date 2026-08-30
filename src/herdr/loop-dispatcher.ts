import type { Dispatcher, StageDispatchResult } from "../core/loop.ts";
import type { Role, Task } from "../core/types.ts";
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

  dispatchStage(task: Task, role: Role, prompt: string): Promise<StageDispatchResult> {
    return dispatchStage(this.herdr, task, role, prompt, this.prefix, this.opts);
  }

  archiveTaskSpace(task: Task): Promise<void> {
    return archiveTaskSpace(this.herdr, task);
  }

}
