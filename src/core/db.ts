import { DatabaseSync } from "node:sqlite";

/**
 * SQLite persistence for one Faktory instance. Uses the Node built-in driver
 * (synchronous, WAL) — no native deps. Schema is migrated in order; add new
 * migrations at the end, never edit old ones.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE sources (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    config     TEXT NOT NULL,            -- JSON, no secrets
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE secrets (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id    TEXT NOT NULL REFERENCES sources(id),
    item_id      TEXT NOT NULL,
    title        TEXT NOT NULL,
    url          TEXT NOT NULL,
    phase        TEXT NOT NULL,
    priority     REAL,
    workspace_id TEXT,
    pane_id      TEXT,
    agent_name   TEXT,
    branch       TEXT,
    pr_url       TEXT,
    error        TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (source_id, item_id)
  );
  CREATE TABLE task_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "from"  TEXT,
    "to"    TEXT NOT NULL,
    actor   TEXT NOT NULL,
    note    TEXT
  );
  CREATE TABLE herdr_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    type    TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX idx_tasks_phase ON tasks(phase);
  CREATE INDEX idx_task_events_task ON task_events(task_id);
  `,
  // Migration 2: the programmatic engine loop. Replace the old 11-phase
  // lifecycle with the pipeline (backlog → to_shape → to_execute → to_review →
  // ready → done + blocked/archived); add the inbox (agent→loop channel), the
  // action feed, and per-task stage tabs.
  `
  -- Remap existing task phases onto the new pipeline (best-effort).
  UPDATE tasks SET phase = CASE phase
    WHEN 'discovered'      THEN 'backlog'
    WHEN 'queued'          THEN 'backlog'
    WHEN 'dispatching'     THEN 'to_execute'
    WHEN 'running'         THEN 'to_execute'
    WHEN 'reviewing'       THEN 'to_review'
    WHEN 'ready_to_deploy' THEN 'ready'
    WHEN 'deploying'       THEN 'ready'
    WHEN 'done'            THEN 'done'
    WHEN 'failed'          THEN 'blocked'
    WHEN 'cancelled'       THEN 'archived'
    ELSE phase
  END;

  ALTER TABLE tasks ADD COLUMN stage         TEXT;
  ALTER TABLE tasks ADD COLUMN resume_phase  TEXT;
  -- Explicit "an agent is working this lane task" signal (set on dispatch,
  -- cleared on completion/block/stall). Distinguishes a lane task being worked
  -- from one still waiting in the loop's inbox.
  ALTER TABLE tasks ADD COLUMN dispatched_at TEXT;

  CREATE TABLE task_stages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id),
    stage      TEXT NOT NULL,
    pane_id    TEXT,
    agent_name TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (task_id, stage)
  );

  CREATE TABLE inbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id),
    stage      TEXT,
    type       TEXT NOT NULL,          -- completed | needs_human | note
    sender     TEXT,                   -- herdr agent name
    note       TEXT,
    data       TEXT,                   -- JSON handoff payload
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    applied_at TEXT,                   -- when the loop consumed it (null = pending)
    outcome    TEXT                    -- applied | rejected:<reason> | surfaced
  );
  CREATE INDEX idx_inbox_pending ON inbox(task_id) WHERE applied_at IS NULL;

  CREATE TABLE feed (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    task_id INTEGER,
    kind    TEXT NOT NULL,             -- sync|transition|dispatch|inbox|annotation|stall
    actor   TEXT NOT NULL,             -- engine | agent:<name>
    message TEXT NOT NULL
  );
  CREATE INDEX idx_feed_at ON feed(id DESC);
  `,
];

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(i + 1);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/** Simple typed key/value access over the config table. */
export function getConfig(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setConfig(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function getSecret(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM secrets WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSecret(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
