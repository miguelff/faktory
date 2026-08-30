import { DatabaseSync } from "node:sqlite";

/**
 * SQLite persistence for one Faktory instance. Uses the Node built-in driver
 * (synchronous, WAL) — no native deps.
 *
 * The datasource is the source of truth; this database is a local *snapshot*.
 * Every task state operation writes remotely first (see the outbox + the
 * remote proxy in core/engine.ts) and only projects here once the datasource
 * acknowledges it. The schema is a single declaration — no migrations; the
 * database is disposable and recreated from the datasource on demand.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  config     TEXT NOT NULL,            -- JSON, no secrets
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS secrets (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     TEXT NOT NULL REFERENCES sources(id),
  item_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  url           TEXT NOT NULL,
  phase         TEXT NOT NULL,
  priority      REAL,
  workspace_id  TEXT,
  pane_id       TEXT,
  agent_name    TEXT,
  stage         TEXT,
  dispatched_at TEXT,
  branch        TEXT,
  pr_url        TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (source_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase);

CREATE TABLE IF NOT EXISTS task_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "from"  TEXT,
  "to"    TEXT NOT NULL,
  actor   TEXT NOT NULL,
  note    TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);

CREATE TABLE IF NOT EXISTS task_stages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  stage      TEXT NOT NULL,
  pane_id    TEXT,
  agent_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (task_id, stage)
);

CREATE TABLE IF NOT EXISTS inbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  stage      TEXT,
  type       TEXT NOT NULL,          -- handoff | note
  sender     TEXT,                   -- herdr agent name
  note       TEXT,
  data       TEXT,                   -- JSON handoff payload
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  applied_at TEXT,                   -- when the loop consumed it (null = pending)
  outcome    TEXT                    -- applied | rejected:<reason> | surfaced
);
CREATE INDEX IF NOT EXISTS idx_inbox_pending ON inbox(task_id) WHERE applied_at IS NULL;

CREATE TABLE IF NOT EXISTS feed (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  task_id INTEGER,
  kind    TEXT NOT NULL,             -- sync|transition|dispatch|inbox|annotation|repair|error
  actor   TEXT NOT NULL,             -- engine | agent:<name>
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_at ON feed(id DESC);

-- The outbox: durable intent for every remote write. A task state operation is
-- enqueued here, attempted against the datasource, and only projected onto the
-- local snapshot once the datasource acknowledges it. A write that fails
-- (datasource unavailable) stays pending and is retried on a backoff — never
-- lost, never applied locally ahead of the datasource. No local-first mode.
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER,
  op              TEXT NOT NULL,          -- JSON: the remote write + its local effect
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_at         TEXT,                   -- earliest retry time (backoff); null = now
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acknowledged_at TEXT                    -- when the datasource confirmed the write
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(id) WHERE acknowledged_at IS NULL;

-- The local error log — inconsistencies live HERE, never in the datasource.
-- A failed/exhausted write-through, a lost CAS, or a value the reconciliation
-- job found to differ remotely vs locally is flagged as an open error an
-- operator can see in the TUI and mark resolved. The fingerprint collapses a
-- recurring inconsistency to a single open row.
CREATE TABLE IF NOT EXISTS errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind        TEXT NOT NULL,          -- write-through | cas | reconcile
  fingerprint TEXT,                   -- dedup key for an open inconsistency
  message     TEXT NOT NULL,
  detail      TEXT,                   -- JSON: remote vs local values
  resolved_at TEXT                    -- null = still open
);
CREATE INDEX IF NOT EXISTS idx_errors_open ON errors(resolved_at) WHERE resolved_at IS NULL;
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
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
