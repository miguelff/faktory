import { setTimeout as sleep } from "node:timers/promises";
import type { WorkItem, WorkItemDetails } from "../core/types.ts";
import { FAKTORY_STATUSES } from "../core/lifecycle.ts";
import type { SourceConfigRecord, SourceContext, WorkSource } from "./types.ts";

/** Terminal faktory_status that must never resurface as a candidate. */
const DONE = "done";

/**
 * Notion work source adapter.
 *
 * Ownership lives in three faktory-managed properties on the database:
 *   faktory_status   (select)     — discoverable | <phase>
 *   faktory_owned_by (rich_text)  — instance prefix that owns the entry
 *   faktory_owned_at (date)       — when ownership was stamped
 * Every page is discoverable while faktory_owned_by is empty; claiming is a
 * best-effort CAS (Notion has no transactions: write, then verify the winner).
 */
export interface NotionSourceConfig {
  databaseId: string;
  /** Optional numeric priority property, e.g. "Priority". */
  priorityProperty?: string;
  /** Property names, fixed by convention but overridable. */
  statusProperty?: string;
  ownedByProperty?: string;
  ownedAtProperty?: string;
  /** Key in the instance secret store holding the token. Default "notion.token". */
  tokenSecret?: string;
}

export const FAKTORY_STATUS = "faktory_status";
export const FAKTORY_OWNED_BY = "faktory_owned_by";
export const FAKTORY_OWNED_AT = "faktory_owned_at";

const NOTION_VERSION = "2022-06-28";

function propNames(cfg: NotionSourceConfig) {
  return {
    status: cfg.statusProperty ?? FAKTORY_STATUS,
    ownedBy: cfg.ownedByProperty ?? FAKTORY_OWNED_BY,
    ownedAt: cfg.ownedAtProperty ?? FAKTORY_OWNED_AT,
  };
}

/** Pure: normalize a Notion page object into a WorkItem. Exported for tests. */
export function pageToWorkItem(page: any, cfg: NotionSourceConfig): WorkItem {
  const names = propNames(cfg);
  const props = page.properties ?? {};
  const titleProp: any = Object.values(props).find((p: any) => p?.type === "title");
  const title = (titleProp?.title ?? []).map((t: any) => t.plain_text).join("") || "(untitled)";

  const status = props[names.status]?.select?.name ?? null;
  const ownedBy =
    (props[names.ownedBy]?.rich_text ?? []).map((t: any) => t.plain_text).join("") || null;
  const ownedAt = props[names.ownedAt]?.date?.start ?? null;

  const prioProp = cfg.priorityProperty ? props[cfg.priorityProperty] : undefined;
  const priority = prioProp?.type === "number" ? (prioProp.number ?? null) : null;

  return {
    id: page.id,
    title,
    url: page.url,
    status,
    ownedBy,
    ownedAt,
    priority,
    updatedAt: page.last_edited_time ?? null,
    raw: page,
  };
}

/** Pure: flatten Notion rich_text to markdown-ish inline text (links kept). */
function richText(rt: any[] | undefined): string {
  return (rt ?? [])
    .map((t: any) => {
      const text = t.plain_text ?? "";
      return t.href ? `[${text}](${t.href})` : text;
    })
    .join("");
}

/**
 * Pure: render Notion blocks as markdown. Covers the common block types and
 * degrades gracefully — an unknown block renders its rich_text (when it has
 * any) as a plain paragraph. Flat: child blocks are not fetched recursively.
 * Exported for tests.
 */
export function blocksToMarkdown(blocks: any[]): string {
  let numbered = 0;
  const lines: string[] = [];
  for (const b of blocks) {
    const data = b[b.type] ?? {};
    if (b.type !== "numbered_list_item") numbered = 0;
    switch (b.type) {
      case "heading_1":
        lines.push(`# ${richText(data.rich_text)}`);
        break;
      case "heading_2":
        lines.push(`## ${richText(data.rich_text)}`);
        break;
      case "heading_3":
        lines.push(`### ${richText(data.rich_text)}`);
        break;
      case "bulleted_list_item":
        lines.push(`- ${richText(data.rich_text)}`);
        break;
      case "numbered_list_item":
        lines.push(`${++numbered}. ${richText(data.rich_text)}`);
        break;
      case "to_do":
        lines.push(`- [${data.checked ? "x" : " "}] ${richText(data.rich_text)}`);
        break;
      case "quote":
        lines.push(`> ${richText(data.rich_text)}`);
        break;
      case "callout":
        lines.push(`> ${richText(data.rich_text)}`);
        break;
      case "code":
        lines.push("```" + (data.language ?? ""), richText(data.rich_text), "```");
        break;
      case "divider":
        lines.push("---");
        break;
      case "child_page":
        lines.push(`(subpage: ${data.title ?? ""})`);
        break;
      case "child_database":
        lines.push(`(database: ${data.title ?? ""})`);
        break;
      default: {
        const text = richText(data.rich_text);
        if (text) lines.push(text);
      }
    }
  }
  return lines.join("\n").trim();
}

/**
 * Pure: the page's source-native properties, simplified to plain values. The
 * faktory-managed columns and the title (already surfaced) are excluded.
 * Exported for tests.
 */
export function pageMeta(page: any, cfg: NotionSourceConfig): Record<string, unknown> {
  const names = propNames(cfg);
  const internal = new Set<string>([names.status, names.ownedBy, names.ownedAt]);
  const meta: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries<any>(page.properties ?? {})) {
    if (internal.has(name) || prop?.type === "title") continue;
    const value = simplifyProp(prop);
    if (value != null) meta[name] = value;
  }
  return meta;
}

function simplifyProp(prop: any): unknown {
  switch (prop?.type) {
    case "select":
      return prop.select?.name ?? null;
    case "status":
      return prop.status?.name ?? null;
    case "multi_select":
      return (prop.multi_select ?? []).map((o: any) => o.name);
    case "number":
      return prop.number;
    case "checkbox":
      return prop.checkbox;
    case "date":
      return prop.date?.start ?? null;
    case "url":
      return prop.url;
    case "email":
      return prop.email;
    case "rich_text":
      return richText(prop.rich_text) || null;
    case "people":
      return (prop.people ?? []).map((p: any) => p.name).filter(Boolean);
    default:
      return null;
  }
}

/**
 * Pure: candidacy filter — every unowned entry (discoverable by anyone) plus
 * the entries this instance already owns, but never anything already finished
 * (`faktory_status = done`). Archived (trashed) pages are excluded by Notion's
 * query API by default, and defensively skipped in listCandidates. Exported
 * for tests.
 */
export function buildCandidateFilter(cfg: NotionSourceConfig, prefix: string): Record<string, unknown> {
  const names = propNames(cfg);
  return {
    and: [
      {
        or: [
          { property: names.ownedBy, rich_text: { is_empty: true } },
          { property: names.ownedBy, rich_text: { equals: prefix } },
        ],
      },
      { property: names.status, select: { does_not_equal: DONE } },
    ],
  };
}

class NotionSource implements WorkSource {
  readonly kind = "notion";
  private readonly names: ReturnType<typeof propNames>;

  constructor(
    readonly id: string,
    private readonly cfg: NotionSourceConfig,
    private readonly token: string,
    private readonly prefix: string,
    private readonly baseUrl = "https://api.notion.com/v1",
  ) {
    this.names = propNames(cfg);
  }

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
          filter: buildCandidateFilter(this.cfg, this.prefix),
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      });
      for (const page of body.results ?? []) {
        // Defensive: never surface archived/trashed entries even if a source
        // returns them, and never re-pick anything already done.
        if (page.archived || page.in_trash) continue;
        const item = pageToWorkItem(page, this.cfg);
        if (item.status === DONE) continue;
        items.push(item);
      }
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

  /**
   * Best-effort CAS: only proceed when the page is unowned, stamp ownership,
   * then re-read after a short delay — Notion is last-writer-wins, so the
   * verify read reports whichever instance actually holds the entry.
   */
  async claim(itemId: string): Promise<string> {
    const current = (await this.getItem(itemId))?.ownedBy;
    if (current) return current;
    await this.call(`/pages/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          [this.names.ownedBy]: { rich_text: [{ type: "text", text: { content: this.prefix } }] },
          [this.names.ownedAt]: { date: { start: new Date().toISOString() } },
        },
      }),
    });
    await sleep(150 + Math.random() * 200);
    return (await this.getItem(itemId))?.ownedBy ?? this.prefix;
  }

  async unclaim(itemId: string): Promise<void> {
    await this.call(`/pages/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          [this.names.ownedBy]: { rich_text: [] },
          [this.names.ownedAt]: { date: null },
        },
      }),
    });
  }

  async setStatus(itemId: string, status: string): Promise<void> {
    await this.call(`/pages/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: { [this.names.status]: { select: { name: status } } },
      }),
    });
  }

  /**
   * Full detail for `task show --json`: title from the page, body as the
   * page's blocks rendered to markdown, trail from the page's comment thread
   * (oldest first — Notion returns comments in chronological order), meta from
   * the non-faktory page properties.
   */
  async details(itemId: string): Promise<WorkItemDetails> {
    const [page, blocks, comments] = await Promise.all([
      this.call(`/pages/${itemId}`),
      this.paginate(`/blocks/${itemId}/children`),
      this.paginate(`/comments?block_id=${itemId}`),
    ]);
    return {
      title: pageToWorkItem(page, this.cfg).title,
      body: blocksToMarkdown(blocks),
      trail: comments.map((c: any) => richText(c.rich_text)).filter(Boolean),
      meta: pageMeta(page, this.cfg),
    };
  }

  /** Follow a paginated GET, concatenating `results`. */
  private async paginate(path: string): Promise<any[]> {
    const sep = path.includes("?") ? "&" : "?";
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const body = await this.call(`${path}${sep}page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
      out.push(...(body.results ?? []));
      cursor = body.has_more ? body.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  /** Post the handoff marker into the page's comment thread. */
  async comment(itemId: string, body: string): Promise<void> {
    await this.call(`/comments`, {
      method: "POST",
      body: JSON.stringify({
        parent: { page_id: itemId },
        rich_text: [{ type: "text", text: { content: body } }],
      }),
    });
  }

  /** Add missing faktory_* properties to the database schema. */
  async ensureProperties(): Promise<string[]> {
    const db = await this.call(`/databases/${this.cfg.databaseId}`);
    const existing = db.properties ?? {};
    const wanted: Record<string, unknown> = {
      [this.names.status]: { select: { options: FAKTORY_STATUSES.map((name) => ({ name })) } },
      [this.names.ownedBy]: { rich_text: {} },
      [this.names.ownedAt]: { date: {} },
    };
    const missing = Object.keys(wanted).filter((name) => !existing[name]);
    if (missing.length === 0) return [];
    await this.call(`/databases/${this.cfg.databaseId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: Object.fromEntries(missing.map((name) => [name, wanted[name]])),
      }),
    });
    return missing;
  }
}

export function createNotionSource(record: SourceConfigRecord, ctx: SourceContext): WorkSource {
  const cfg = record.config as unknown as NotionSourceConfig;
  if (!cfg.databaseId) {
    throw new Error(`notion source ${record.id}: databaseId is required`);
  }
  const token = ctx.getSecret(cfg.tokenSecret ?? "notion.token");
  if (!token) throw new Error(`notion source ${record.id}: missing secret "${cfg.tokenSecret ?? "notion.token"}"`);
  return new NotionSource(record.id, cfg, token, ctx.prefix, ctx.baseUrl);
}
