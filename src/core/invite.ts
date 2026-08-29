/**
 * Collaboration invites — the wire format that lets one operator share the
 * datasource their Faktory config points at so a colleague can `join` it.
 *
 * An invite "models the data source configuration this instance is using":
 * the source kind, its (non-secret) adapter config, and the access secret
 * needed to reach it. The joining operator gets their **own** config (own
 * slug/prefix) pointed at the **same** datasource, so both instances can
 * discover every entry and each owns only what it claims (faktory_owned_by).
 *
 * Pure module: encode/decode/compare only. No I/O, no secrets storage — the
 * caller reads the secret from the instance store and hands it in.
 *
 * ⚠ An invite string carries an access secret in plain text. Treat it like a
 * password: share it over a trusted channel, never commit it.
 */

/** Current invite envelope. `secret` is the datasource access token, if any. */
export interface Invite {
  v: 1;
  kind: string;
  config: Record<string, unknown>;
  secret?: string;
}

/** Opaque, URL-/shell-safe prefix that identifies + versions an invite string. */
const PREFIX = "fkinv1_";

/** Encode an invite into a single opaque, copy-pasteable string. */
export function encodeInvite(invite: Invite): string {
  if (invite.v !== 1) throw new Error(`unsupported invite version ${invite.v}`);
  if (!invite.kind) throw new Error("invite is missing a source kind");
  const json = JSON.stringify({ v: invite.v, kind: invite.kind, config: invite.config, secret: invite.secret });
  return PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

/** Decode + validate an invite string. Throws a clear error on anything off. */
export function decodeInvite(str: string): Invite {
  const trimmed = str.trim();
  if (!trimmed.startsWith(PREFIX)) {
    throw new Error("not a faktory invite string (expected a value produced by `faktory invite`)");
  }
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("invite string is corrupted — copy it again in full");
  }
  if (parsed?.v !== 1) throw new Error(`unsupported invite version ${parsed?.v}`);
  if (typeof parsed.kind !== "string" || !parsed.kind) throw new Error("invite is missing a source kind");
  if (typeof parsed.config !== "object" || parsed.config === null) throw new Error("invite is missing its source config");
  if (parsed.secret !== undefined && typeof parsed.secret !== "string") throw new Error("invite has a malformed secret");
  return { v: 1, kind: parsed.kind, config: parsed.config as Record<string, unknown>, secret: parsed.secret };
}

/**
 * A stable identity for the *datasource* an invite/source points at, used to
 * detect when a colleague is joining a datasource they already have a config
 * for. For Notion this is the database id, normalized so dashed and dashless
 * forms match; other kinds fall back to a stable stringification of the config.
 *
 * Caveat for new kinds: the generic fallback hashes the *whole* config, so a
 * stored config and an invite config that differ by even one incidental field
 * (e.g. a mapping tweak) would look like different datasources and slip past
 * duplicate-join detection. Add a kind-specific branch that keys on the true
 * datasource identity (like Notion's databaseId) when you add a work source.
 */
export function datasourceIdentity(kind: string, config: Record<string, unknown>): string {
  if (kind === "notion" && typeof config.databaseId === "string") {
    return `notion:${config.databaseId.replace(/-/g, "").toLowerCase()}`;
  }
  return `${kind}:${stableStringify(config)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
