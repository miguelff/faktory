import { mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A Faktory *instance* is one named orchestration: its own SQLite DB, secrets,
 * port, and tag prefix. Several instances can coexist on one machine and even
 * on one source database (the prefix keeps their tags apart).
 */
export interface InstanceRef {
  name: string;
  slug: string;
  /** Tag/status convention prefix: `faktory-<slug>` */
  prefix: string;
  dir: string;
  dbPath: string;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`Cannot derive a slug from instance name ${JSON.stringify(name)}`);
  return slug;
}

export function faktoryHome(): string {
  return process.env.FAKTORY_HOME ?? join(homedir(), ".faktory");
}

export function instanceRef(name: string): InstanceRef {
  const slug = slugify(name);
  const dir = join(faktoryHome(), slug);
  return { name, slug, prefix: `faktory-${slug}`, dir, dbPath: join(dir, "faktory.sqlite") };
}

export function ensureInstanceDir(ref: InstanceRef): InstanceRef {
  mkdirSync(ref.dir, { recursive: true, mode: 0o700 });
  return ref;
}

export function listInstances(): string[] {
  const home = faktoryHome();
  if (!existsSync(home)) return [];
  return readdirSync(home, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(home, e.name, "faktory.sqlite")))
    .map((e) => e.name)
    .sort();
}

/**
 * Delete a config's entire local state directory (SQLite DB + secrets). Returns
 * false when no such config exists, so callers can report an unknown-config
 * error instead of silently succeeding. Notion-side ownership tags on already
 * claimed items are intentionally left untouched — this only removes the local
 * orchestration state under ~/.faktory/<slug>/.
 */
export function removeInstance(name: string): boolean {
  const ref = instanceRef(name);
  if (!existsSync(ref.dbPath)) return false;
  rmSync(ref.dir, { recursive: true, force: true });
  return true;
}
