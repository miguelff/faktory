import { instanceRef, listInstances } from "./core/instance.ts";
import { openDb } from "./core/db.ts";
import { datasourceIdentity } from "./core/invite.ts";

/**
 * Collaboration lookups over the local configs. Application-level (touches the
 * per-config SQLite stores), so it lives outside the pure core: cli.ts uses it
 * to keep `join` from linking a datasource an existing config already owns.
 *
 * Returns the slug of the first existing config whose source resolves to the
 * same `datasourceIdentity`, or null when the datasource is new to this
 * machine. Comparing on identity (not raw config) makes dashed/dashless Notion
 * ids and reordered config keys match.
 */
export function findConfigLinkingDatasource(identity: string): string | null {
  for (const slug of listInstances()) {
    const db = openDb(instanceRef(slug).dbPath);
    try {
      const rows = db.prepare("SELECT kind, config FROM sources").all() as { kind: string; config: string }[];
      for (const row of rows) {
        if (datasourceIdentity(row.kind, JSON.parse(row.config)) === identity) return slug;
      }
    } finally {
      db.close();
    }
  }
  return null;
}
