import type { SourceConfigRecord, SourceContext, WorkSource } from "./types.ts";
import { createNotionSource } from "./notion.ts";

/**
 * Abstract factory for work sources. Adding a new backend (Jira, GitHub, …)
 * is: implement WorkSource in its own module, register a creator here. The
 * engine, API, TUI, and skills never learn about concrete source types.
 */
export type SourceCreator = (record: SourceConfigRecord, ctx: SourceContext) => WorkSource;

const registry = new Map<string, SourceCreator>();

export function registerSourceKind(kind: string, creator: SourceCreator): void {
  registry.set(kind, creator);
}

export function availableSourceKinds(): string[] {
  return [...registry.keys()].sort();
}

export function createSource(record: SourceConfigRecord, ctx: SourceContext): WorkSource {
  const creator = registry.get(record.kind);
  if (!creator) {
    throw new Error(
      `Unknown work source kind ${JSON.stringify(record.kind)}. Available: ${availableSourceKinds().join(", ") || "(none)"}`,
    );
  }
  return creator(record, ctx);
}

// Built-in adapters. Jira/GitHub will register here when implemented.
registerSourceKind("notion", createNotionSource);
