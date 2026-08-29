import type { WorkItem } from "../core/types.ts";

/**
 * The WorkSource port. Faktory's engine only ever talks to this interface;
 * Notion / Jira / GitHub are adapters behind the factory in ./factory.ts.
 *
 * Candidacy is source-specific and lives inside the adapter's config:
 *  - Notion: database id + a property + value (a query filter)
 *  - GitHub (future): repository + issues search query
 *  - Jira   (future): JQL
 */
export interface WorkSource {
  readonly kind: string;
  readonly id: string;

  /** Items currently matching the source's candidacy filter. */
  listCandidates(): Promise<WorkItem[]>;

  getItem(itemId: string): Promise<WorkItem | null>;

  /** Write a native status label back to the source. */
  setStatus(itemId: string, status: string): Promise<void>;

  /** Tag management (optional capability — not all sources have labels). */
  addTag?(itemId: string, tag: string): Promise<void>;
  removeTag?(itemId: string, tag: string): Promise<void>;

  /**
   * Provision the instance's convention tags in the source so they can be
   * filtered on (Notion rejects queries on unknown multi_select options).
   * Returns the tags that were newly created.
   */
  ensureTags?(tags: string[]): Promise<string[]>;
}

/** Persisted (non-secret) source configuration. */
export interface SourceConfigRecord {
  id: string;
  kind: string;
  /** JSON adapter config, shape owned by the adapter. */
  config: Record<string, unknown>;
}

/** What the factory hands to adapter constructors. */
export interface SourceContext {
  /** Resolve a secret by key (tokens live in the instance secret store). */
  getSecret(key: string): string | null;
  /** Instance tag prefix, e.g. `faktory-omnia`. */
  prefix: string;
  /** Override the API base URL (used by integration tests). */
  baseUrl?: string;
}
