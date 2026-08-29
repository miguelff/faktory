import type { WorkItem } from "../core/types.ts";

/**
 * The WorkSource port. Faktory's engine only ever talks to this interface;
 * Notion / Jira / GitHub are adapters behind the factory in ./factory.ts.
 *
 * Ownership model: every entry in the backing database is *discoverable* by
 * every faktory instance. An instance owns an entry the moment it moves it
 * away from discoverable — a compare-and-swap on faktory_owned_by — and only
 * the owning instance may manage it from then on. faktory_status mirrors the
 * owner's lifecycle phase; faktory_owned_at records when ownership was taken.
 */
export interface WorkSource {
  readonly kind: string;
  readonly id: string;

  /** Discoverable (unowned) items plus the items owned by this instance. */
  listCandidates(): Promise<WorkItem[]>;

  getItem(itemId: string): Promise<WorkItem | null>;

  /**
   * Claim ownership of an item (CAS): stamp faktory_owned_by/_owned_at only
   * if it is still unowned. Resolves to the winning owner — equal to this
   * instance's prefix on success, another prefix when the claim was lost.
   */
  claim(itemId: string): Promise<string>;

  /** Write faktory_status back to the source. Only for items this instance owns. */
  setStatus(itemId: string, status: string): Promise<void>;

  /**
   * Leave a handoff-trail comment on the work item. `body` is a pre-rendered,
   * provider-agnostic string (see core/handoff.ts) — the adapter only decides
   * where comments live for its backend (Notion page comments, GitHub issue
   * comments, …). Only for items this instance owns.
   */
  comment(itemId: string, body: string): Promise<void>;

  /**
   * Add the faktory_* properties to the backing database if missing, so any
   * database can be pointed at as-is. Returns the properties created.
   */
  ensureProperties?(): Promise<string[]>;
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
  /** Instance identity stamped into faktory_owned_by, e.g. `faktory-omnia`. */
  prefix: string;
  /** Override the API base URL (used by integration tests). */
  baseUrl?: string;
}
