/**
 * Handoff papertrail — the pure, source-independent representation of one
 * lane-to-lane handoff on a work unit. It renders to a self-describing marker
 * with the routing as attributes and a human-readable body, e.g.:
 *
 *   <handoff from="review" to="execute" agent="pi">Blocker: missing tests.</handoff>
 *
 * Adapters (WorkSource.comment) post the rendered string verbatim (a Notion
 * comment, a GitHub issue comment, …), so the task accumulates a feed of
 * handoffs — the papertrail. This module never touches I/O — formatting is a
 * domain concern.
 */

export type HandoffValue = string | number | boolean;

export interface Handoff {
  /** Lane (or phase) the task is leaving. */
  from?: string | null;
  /** Lane (or phase) the task is routed to; absent for an in-place note. */
  to?: string | null;
  /** Human-readable body of the comment. */
  note?: string | null;
  /** Extra data-attributes rendered on the marker, in insertion order. */
  data?: Record<string, HandoffValue | null | undefined>;
}

/** The element name used for the handoff marker. */
export const HANDOFF_TAG = "handoff";

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
 * Render a handoff into its marker string. `from` and `to` come first (when
 * present); remaining `data` entries follow in insertion order, skipping
 * null/undefined. All values are escaped so the marker is always well-formed.
 */
export function renderHandoff(h: Handoff): string {
  const attrs: Array<[string, HandoffValue]> = [];
  if (h.from != null && h.from !== "") attrs.push(["from", h.from]);
  if (h.to != null && h.to !== "") attrs.push(["to", h.to]);
  for (const [name, value] of Object.entries(h.data ?? {})) {
    if (value == null) continue;
    if (!isValidAttrName(name)) {
      throw new Error(`invalid handoff data-attribute name ${JSON.stringify(name)}`);
    }
    if (name === "from" || name === "to") continue; // top-level fields win
    attrs.push([name, value]);
  }
  const rendered = attrs.map(([n, v]) => `${n}="${escapeAttr(String(v))}"`).join(" ");
  const open = rendered ? `<${HANDOFF_TAG} ${rendered}>` : `<${HANDOFF_TAG}>`;
  const body = h.note != null ? escapeText(h.note) : "";
  return `${open}${body}</${HANDOFF_TAG}>`;
}
