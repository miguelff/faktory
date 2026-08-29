import type { WorkItem } from "../core/types.ts";
import type { SourceConfigRecord, SourceContext, WorkSource } from "./types.ts";

/**
 * Notion work source adapter.
 *
 * Candidacy = database + property + value: a page is a candidate when
 * `candidateProperty` (multi_select | select | status | checkbox) matches
 * `candidateValue`, minus archived/terminal rows.
 */
export interface NotionSourceConfig {
  databaseId: string;
  /** Property that determines candidacy, e.g. "Tags". */
  candidateProperty: string;
  /** Value of that property that marks a candidate, e.g. "faktory-omnia-execute". */
  candidateValue: string;
  /** Status property written back per phase, e.g. "Status". */
  statusProperty?: string;
  /** Multi-select property used for lifecycle mirror tags (often same as candidateProperty). */
  tagsProperty?: string;
  /** Optional numeric priority property, e.g. "Priority". */
  priorityProperty?: string;
  /** Native status labels to exclude from candidacy. */
  excludeStatuses?: string[];
  /** Key in the instance secret store holding the token. Default "notion.token". */
  tokenSecret?: string;
}

const NOTION_VERSION = "2022-06-28";

/** Pure: normalize a Notion page object into a WorkItem. Exported for tests. */
export function pageToWorkItem(page: any, cfg: NotionSourceConfig): WorkItem {
  const props = page.properties ?? {};
  const titleProp: any = Object.values(props).find((p: any) => p?.type === "title");
  const title = (titleProp?.title ?? []).map((t: any) => t.plain_text).join("") || "(untitled)";

  const statusProp = cfg.statusProperty ? props[cfg.statusProperty] : undefined;
  const status =
    statusProp?.type === "status"
      ? (statusProp.status?.name ?? null)
      : statusProp?.type === "select"
        ? (statusProp.select?.name ?? null)
        : null;

  const tagsProp = cfg.tagsProperty ? props[cfg.tagsProperty] : undefined;
  const tags =
    tagsProp?.type === "multi_select" ? tagsProp.multi_select.map((o: any) => o.name as string) : [];

  const prioProp = cfg.priorityProperty ? props[cfg.priorityProperty] : undefined;
  const priority = prioProp?.type === "number" ? (prioProp.number ?? null) : null;

  return {
    id: page.id,
    title,
    url: page.url,
    status,
    tags,
    priority,
    updatedAt: page.last_edited_time ?? null,
    raw: page,
  };
}

/** Pure: build the database query filter for candidacy. Exported for tests. */
export function buildCandidateFilter(cfg: NotionSourceConfig): Record<string, unknown> {
  const and: Record<string, unknown>[] = [
    // Property type is config-time knowledge; multi_select "contains" is the
    // common case (Tags). Select/status/checkbox variants are chosen by shape.
    { property: cfg.candidateProperty, multi_select: { contains: cfg.candidateValue } },
  ];
  for (const status of cfg.excludeStatuses ?? []) {
    if (cfg.statusProperty) {
      and.push({ property: cfg.statusProperty, status: { does_not_equal: status } });
    }
  }
  return { and };
}

class NotionSource implements WorkSource {
  readonly kind = "notion";

  constructor(
    readonly id: string,
    private readonly cfg: NotionSourceConfig,
    private readonly token: string,
    private readonly baseUrl = "https://api.notion.com/v1",
  ) {}

  private async call(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Notion ${res.status} on ${path}: ${body?.message ?? JSON.stringify(body)}`);
    }
    return body;
  }

  async listCandidates(): Promise<WorkItem[]> {
    const items: WorkItem[] = [];
    let cursor: string | undefined;
    do {
      const body = await this.call(`/databases/${this.cfg.databaseId}/query`, {
        method: "POST",
        body: JSON.stringify({
          filter: buildCandidateFilter(this.cfg),
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      });
      for (const page of body.results ?? []) items.push(pageToWorkItem(page, this.cfg));
      cursor = body.has_more ? body.next_cursor : undefined;
    } while (cursor);
    return items;
  }

  async getItem(itemId: string): Promise<WorkItem | null> {
    try {
      const page = await this.call(`/pages/${itemId}`);
      return pageToWorkItem(page, this.cfg);
    } catch (e) {
      if (String(e).includes("Notion 404")) return null;
      throw e;
    }
  }

  async setStatus(itemId: string, status: string): Promise<void> {
    if (!this.cfg.statusProperty) return;
    await this.call(`/pages/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: { [this.cfg.statusProperty]: { status: { name: status } } },
      }),
    });
  }

  async addTag(itemId: string, tag: string): Promise<void> {
    await this.mutateTags(itemId, (tags) => (tags.includes(tag) ? tags : [...tags, tag]));
  }

  async removeTag(itemId: string, tag: string): Promise<void> {
    await this.mutateTags(itemId, (tags) => tags.filter((t) => t !== tag));
  }

  /** Notion multi_select PATCH replaces the whole array: read-modify-write. */
  private async mutateTags(itemId: string, fn: (tags: string[]) => string[]): Promise<void> {
    const prop = this.cfg.tagsProperty ?? this.cfg.candidateProperty;
    const page = await this.call(`/pages/${itemId}`);
    const current: string[] =
      page.properties?.[prop]?.multi_select?.map((o: any) => o.name as string) ?? [];
    const next = fn(current);
    if (next.length === current.length && next.every((t, i) => t === current[i])) return;
    await this.call(`/pages/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: { [prop]: { multi_select: next.map((name) => ({ name })) } },
      }),
    });
  }
}

export function createNotionSource(record: SourceConfigRecord, ctx: SourceContext): WorkSource {
  const cfg = record.config as unknown as NotionSourceConfig;
  if (!cfg.databaseId || !cfg.candidateProperty || !cfg.candidateValue) {
    throw new Error(`notion source ${record.id}: databaseId, candidateProperty and candidateValue are required`);
  }
  const token = ctx.getSecret(cfg.tokenSecret ?? "notion.token");
  if (!token) throw new Error(`notion source ${record.id}: missing secret "${cfg.tokenSecret ?? "notion.token"}"`);
  return new NotionSource(record.id, cfg, token, ctx.baseUrl);
}
