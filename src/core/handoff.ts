/**
 * Handoff trail — the pure, source-independent representation of a note the
 * Faktory loop leaves on a work unit. It renders to a self-describing marker
 * that carries structured data-attributes and a human-readable body, e.g.:
 *
 *   <faktory agent="pi" status="running" iteration="2">Plan approved, executing.</faktory>
 *
 * The marker is provider-agnostic: adapters (WorkSource.comment) post the
 * rendered string verbatim (a Notion comment, a GitHub issue comment, …). This
 * module never touches I/O — formatting is a domain concern.
 */

export type HandoffValue = string | number | boolean;

export interface Handoff {
  /** Agent that produced the handoff (e.g. "pi", "reviewer"). */
  agent?: string | null;
  /** Loop/agent status at this point (e.g. "running", "review-passed"). */
  status?: string | null;
  /** Human-readable body of the comment. */
  note?: string | null;
  /** Extra data-attributes rendered on the marker, in insertion order. */
  data?: Record<string, HandoffValue | null | undefined>;
}

/** The element name used for the handoff marker. */
export const HANDOFF_TAG = "faktory";

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Attribute names must be simple identifiers so the marker stays parseable. */
function isValidAttrName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name);
}

/**
 * Render a handoff into its marker string. `agent` and `status` come first (when
 * present); remaining `data` entries follow in insertion order, skipping
 * null/undefined. All values are escaped so the marker is always well-formed.
 */
export function renderHandoff(h: Handoff): string {
  const attrs: Array<[string, HandoffValue]> = [];
  if (h.agent != null && h.agent !== "") attrs.push(["agent", h.agent]);
  if (h.status != null && h.status !== "") attrs.push(["status", h.status]);
  for (const [name, value] of Object.entries(h.data ?? {})) {
    if (value == null) continue;
    if (!isValidAttrName(name)) {
      throw new Error(`invalid handoff data-attribute name ${JSON.stringify(name)}`);
    }
    if (name === "agent" || name === "status") continue; // top-level fields win
    attrs.push([name, value]);
  }
  const rendered = attrs.map(([n, v]) => `${n}="${escapeAttr(String(v))}"`).join(" ");
  const open = rendered ? `<${HANDOFF_TAG} ${rendered}>` : `<${HANDOFF_TAG}>`;
  const body = h.note != null ? escapeText(h.note) : "";
  return `${open}${body}</${HANDOFF_TAG}>`;
}
