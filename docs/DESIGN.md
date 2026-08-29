# Faktory — design

Faktory is a **local orchestration system** that turns a backlog of issues (in
Notion, and later Jira/GitHub) into shipped work, by driving coding agents
inside [herdr](https://herdr.dev). It runs in your terminal, inside herdr
itself, and manages herdr workspaces/panes/agents through herdr's socket API.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Work sources (abstract)         Faktory serve process                 │
│  ┌───────────┐                   ┌───────────────────────────────┐     │
│  │  Notion   │  listCandidates   │  SQLite (config + state + inbox)│    │
│  │  (Jira)   │◀─────────────────▶│  Lifecycle state machine       │     │
│  │  (GitHub) │  setStatus/tags   │  ENGINE LOOP (deterministic):   │    │
│  └───────────┘                   │   sync · drain inbox · reconcile│    │
│        ▲                          │   · handoffs · dispatch/role   │     │
│        │                          └───────────────────────────────┘     │
│        │                              │            ▲                    │
│        ▼                              ▼            │ herdr socket + CLI │
│  ┌─────────┐  HTTP    ┌─────────┐  ┌──────────────────────────────┐    │
│  │  TUI    │◀────────▶│  API    │  │  herdr: one space per task,   │    │
│  │ kanban  │  board/  │ inbox+  │  │  one tab per pipeline stage   │    │
│  │ + feed  │  feed    │ board   │  │  ┌──────┐ ┌───────┐ ┌───────┐ │    │
│  └─────────┘          └─────────┘  │  │shape │ │execute│ │review │ │    │
│                            ▲       │  │agent │ │agent  │ │agent  │ │    │
│         faktory report ────┘       │  └──┬───┘ └───┬───┘ └───┬───┘ │    │
│         (agent → inbox channel) ◀──────────────────┴─────────┘     │    │
│                                    └──────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

## The engine loop (no orchestrator agent)

Faktory is a **deterministic mechanism**, end to end. The old prompt-driven
orchestrator agent is gone: a programmatic **engine loop** runs inside the
`serve` process and is the single owner of task state. Each tick it:

1. **syncs** candidates from the source (new items land in `backlog`);
2. **drains the inbox** — validates each agent message (origin + transition
   legality) and serially applies it (advance a stage, hand off to another
   lane, annotate, block);
3. **reconciles** herdr agent state as a safety net (blocked → needs human;
   quiet-without-a-message → nudge once, then flag as stalled);
4. **dispatches** — a stage agent to any lane task that is waiting (not yet
   being worked), and an interactive unblocking session to any blocked task
   without one. The loop never promotes from `backlog`: that move is a
   human's.

Agents are like goroutines: independent workers with no access to shared state.
The **inbox** is the channel; the loop is the coordinator. Agents never mutate
state or edit the source — they send typed messages through `faktory report`
(which wraps `POST /api/tasks/:id/inbox`) and the loop decides what happens.
Judgement that used to live in a prompt now lives in the stage prompts
(`src/core/stages.ts`) the loop hands each dispatched agent.

## Work source abstraction (abstract factory)

`WorkSource` is the seam. Concrete sources implement the same tiny contract so
the engine never knows whether work comes from Notion, Jira, or GitHub.

```ts
interface WorkSource {
  kind: string;                    // 'notion' | 'jira' | 'github'
  id: string;                      // configured instance id
  listCandidates(q?): Promise<WorkItem[]>;   // the search filter lives here
  getItem(id): Promise<WorkItem | null>;
  setStatus(id, status): Promise<void>;
  addTag?(id, tag): Promise<void>;
  removeTag?(id, tag): Promise<void>;
}
```

- **Candidacy is source-specific.** For Notion: a *database* + a *property* +
  a *value* (a query filter). For GitHub (future): a repo + issue query. For
  Jira (future): a JQL string. Only **Notion** is implemented now; the factory
  registry (`sources/factory.ts`) is ready for the others.
- A `WorkItem` is the normalized unit: `{ id, title, url, status, tags, ... }`.
- `setStatus` writes a *native* status label back to the source. Faktory maps
  its internal lifecycle phase → native status via per-source config.

## Lifecycle (Faktory phases)

Internal, source-independent phases stored in SQLite:

```
backlog → shape → execute → review → release → done → archived
              └── execute/review/release → blocked (resumes its lane) ──┘
```

Only a human moves `backlog → shape` and `done → archived`. Shaping never
blocks: it is an interactive session that ends — on the human's word — back in
`backlog` or on to `execute`. Agents route a task to another lane with a
`handoff` inbox message (review → execute for rework, blocked → its lane on
resolution); each one is mirrored to the source as a `<handoff from to>`
comment, so the task's comment feed is the papertrail. A `blocked` task gets an
interactive unblocking session seeded with why it is blocked.

| phase        | meaning                                                       |
|--------------|--------------------------------------------------------------|
| `backlog`    | discovered candidate, unclaimed; the loop feeds it forward    |
| `shape`      | actionable lane: a shaping agent grills the human to a spec   |
| `execute`    | actionable lane: an agent implements the shaped spec          |
| `review`     | actionable lane: a blind-review agent judges the change       |
| `release`    | review passed / PR ready — awaiting merge or deploy           |
| `done`       | terminal success                                             |
| `blocked`    | out-of-band: needs a human (agent asked, herdr-blocked, stall)|
| `archived`   | out-of-band: removed from the board (revivable to `backlog`)  |

The four **actionable lanes** (`shape, execute, review, release`) are the
loop's inboxes. A lane task is either *being worked* (a stage agent is
dispatched — `dispatched_at`/`agent_name` set) or *waiting* for the loop to
dispatch one. Ownership (CAS on `faktory_owned_by`) is claimed the moment a task
leaves `backlog`. Each phase maps to a native source status verbatim (`backlog`
→ `discoverable`). Transitions are recorded in `task_events` for the TUI to show
and repair.

## Tag conventions (control plane in the source)

Tags on the source item steer Faktory without leaving the source UI.

**Instances.** On startup you configure a *Faktory instance*; several can
coexist (different repos, teams, or databases). Each instance has a **name**,
slugified into a **prefix**: `faktory-<slug>` (e.g. instance “Omnia” →
`faktory-omnia`). All tag conventions derive from that prefix, so instances
never collide on the same source database:

Ownership lives in three faktory-managed properties, keyed by the instance
prefix so instances never collide on one database:

| property            | effect                                                     |
|---------------------|------------------------------------------------------------|
| `faktory_status`    | mirrors the internal phase verbatim (`backlog` → `discoverable`) |
| `faktory_owned_by`  | the instance prefix that claimed the entry (CAS)           |
| `faktory_owned_at`  | when ownership was stamped                                  |

An entry is discoverable by every instance while `faktory_owned_by` is empty;
the instance that wins the claim (on leaving `backlog`) manages it from then on.

**The datasource is the source of truth for lifecycle state.** Every transition
is *datasource-first*: validate legality → claim (CAS) if leaving `backlog` →
write `faktory_status` to the datasource → only then update the local
projection. The projection can therefore never get ahead of the datasource, so
local and remote cannot drift (the class of “syncing problems” simply cannot
arise). A wiped/rebuilt local DB recovers each owned task's phase by reading
`faktory_status` back. The SQLite DB below is a **projection + local
operational store**, never an independent authority for phase.

Each instance keeps its own state under `~/.faktory/<slug>/` (SQLite DB,
secrets, logs) and runs its own API/TUI on its own port. The remote board is
Notion itself; there is no built-in web UI.

## SQLite state (projection + local operational data)

The datasource owns lifecycle state (phase, ownership); SQLite projects it and
holds data that is inherently local/per-operator (herdr coordinates, the inbox
queue, the action feed) or purely a cache for fast TUI/loop reads.

- `config` — key/value app config (source, repo path, port…)
- `sources` — configured work sources (kind + JSON config, secrets by ref)
- `secrets` — oauth tokens / API keys (local file, `chmod 600`)
- `tasks` — one row per work item (phase, stage, `dispatched_at`, herdr ids, PR…)
- `task_events` — append-only transition/audit log
- `task_stages` — herdr tab/agent per pipeline stage of a task
- `inbox` — typed agent→loop messages (the channel), with applied/outcome
- `feed` — append-only action feed (dispatches, transitions, inbox verdicts…)
- `herdr_events` — raw herdr events (reserved for repair)

## Interfaces

1. **HTTP API** (`src/api`) — thin control plane: board/feed for viewers + the
   inbox endpoint agents report to. JSON over localhost. See `docs/API.md`.
2. **TUI** (`src/tui`) — the local interface: a kanban board of the pipeline
   (all columns except Archived by default, priority-desc, Done hideable,
   scrollable) plus a live action feed. Also the manual-repair console.
3. **Notion** — the remote board: browsable, editable, collaborative. Faktory
   mirrors every phase to `faktory_status`, so the source *is* the web UI.

## herdr integration

Faktory speaks herdr's newline-delimited JSON socket (`HERDR_SOCKET_PATH`) and
shells the `herdr` CLI for interactive agent startup. Each task gets its **own
herdr space** (a worktree workspace, labelled `<prefix>:t<id>`) and **one tab
per pipeline stage** inside it; dispatch = `worktree.create` (first stage) →
`tab.create` (later stages) → `agent.start` → `agent.prompt <stage prompt>`.
Archiving a task closes its space (`workspace.close`), taking its conversations
with it.

**Attention.** herdr models agent status as `idle | working | blocked | done |
unknown`. The loop reconciles this against the inbox: herdr-`blocked` or
`absent` on a pipeline lane → the task is blocked (needs a human) regardless of
the inbox, while a dead *interactive* session (shape, unblock) is detached and
reopened with the trail; `idle`/`done` with no message → nudge once, then only
*flag* it in the feed for human attention (interactive agents legitimately sit
idle waiting on the human, so a live session is never torn down). Completion
is only ever declared by a terminal `handoff` inbox message from the current dispatched
agent — silence is never read as success, and unsigned/mismatched or
stray-duplicate messages are rejected.

## Installer & onboarding

Faktory ships a macOS installer (`install.sh` + `faktory config new`) so a fresh
machine needs nothing pre-installed:

1. **Bootstrap** (`install.sh`): installs Homebrew if missing, then `node`,
   `pnpm`, `herdr`, and `pi` (plus optional `claude`/`codex` harnesses).
2. **Defaults**: herdr always, pi always as the stage-agent harness.
3. **Auth wizard** (`faktory config new`): walks through authenticating pi against
   an agent-harness provider (Anthropic/OpenAI/etc.), verifies herdr's socket,
   then configures a work source (Notion OAuth or integration token → pick
   database → pick candidacy property/value → map status + tags).
4. Everything lands in `~/.faktory/` (SQLite DB, secrets `chmod 600`).

## Non-goals (v0)

- No cloud/multi-user. Single local operator.
- Only Notion is implemented; Jira/GitHub are factory stubs.
- Deploy is a hookable command, not a built-in CI system.
</content>
</invoke>
