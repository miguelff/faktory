# Faktory — design

Faktory is a **local orchestration system** that turns a backlog of issues (in
Notion, and later Jira/GitHub) into shipped work, by driving coding agents
inside [herdr](https://herdr.dev). It runs in your terminal, inside herdr
itself, and manages herdr workspaces/panes/agents through herdr's socket API.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Work sources (abstract)         Faktory (deterministic engine)        │
│  ┌───────────┐                   ┌───────────────────────────────┐     │
│  │  Notion   │  listCandidates   │  SQLite  (config + state)      │     │
│  │  (Jira)   │◀─────────────────▶│  Lifecycle state machine       │     │
│  │  (GitHub) │  setStatus/tags   │  Reconciler / tick loop        │     │
│  └───────────┘                   └───────────────────────────────┘     │
│        ▲                              │            ▲                    │
│        │                              ▼            │                    │
│  ┌───────────┐   HTTP control    ┌─────────┐   herdr socket API        │
│  │  Web UI   │◀─────plane───────▶│  API    │◀─────────────────┐        │
│  │  (OAuth)  │                   └─────────┘                   ▼        │
│  └───────────┘                       ▲               ┌──────────────┐  │
│  ┌───────────┐                       │               │  herdr       │  │
│  │  TUI      │───inspect/repair──────┘               │ workspaces / │  │
│  └───────────┘                                       │ panes/agents │  │
│                                                      └──────────────┘  │
│  ┌───────────────────────────────────────────┐              ▲         │
│  │ Orchestrator AGENT (pi/claude/codex/hermes)│──/kickoff────┘         │
│  │  policy brain, uses Faktory skills + API   │                        │
│  └───────────────────────────────────────────┘                        │
└──────────────────────────────────────────────────────────────────────┘
```

## Design split: deterministic engine vs. agent policy

Faktory is a **deterministic mechanism**. It owns bookkeeping, the state
machine, herdr mechanics, and source I/O. It never makes judgement calls.

The **orchestrator agent** is the *policy brain*. It runs in its own named
herdr tab ("orchestrator", alongside the "serve" and "tui" tabs) as
`pi`/`claude`/`codex`/`hermes` and drives Faktory through the HTTP API + skills:
it claims the next task, dispatches `/kickoff`, watches, interprets blind
reviews, decides deploys, and repairs stuck state. Judgement lives in the agent;
plumbing lives in Faktory. Either can dispatch — the engine has an optional
auto-dispatch loop as a fallback.

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
discovered → queued → dispatching → running → reviewing
      → (blocked)                → ready_to_deploy → deploying → done
      → (failed) → (cancelled)
```

| phase            | meaning                                             |
|------------------|-----------------------------------------------------|
| `discovered`     | seen in a source candidate query, not yet acted on  |
| `queued`         | eligible + selected, waiting for a concurrency slot |
| `dispatching`    | herdr worktree/pane/agent being created             |
| `running`        | agent working the `/kickoff` loop                   |
| `reviewing`      | blind review / PR ready-for-review pending          |
| `blocked`        | needs a human (agent asked, or an error)            |
| `ready_to_deploy`| review passed / PR mergeable                         |
| `deploying`      | deploy in flight                                    |
| `done` / `failed` / `cancelled` | terminal                             |

Each phase maps to a **native source status** (configurable). Transitions are
recorded in a `task_events` log so the TUI can show and repair history.

## Tag conventions (control plane in the source)

Tags on the source item steer Faktory without leaving the source UI.

**Instances.** On startup you configure a *Faktory instance*; several can
coexist (different repos, teams, or databases). Each instance has a **name**,
slugified into a **prefix**: `faktory-<slug>` (e.g. instance “Omnia” →
`faktory-omnia`). All tag conventions derive from that prefix, so instances
never collide on the same source database:

| role                 | tag (`<prefix>` = `faktory-<slug>`)  | effect                           |
|----------------------|--------------------------------------|----------------------------------|
| candidacy            | `<prefix>-execute`                   | eligible for pickup (the filter) |
| running mirror       | `<prefix>-processing`                | agent working                    |
| blocked mirror       | `<prefix>-stalled`                   | needs a human                    |
| failed mirror        | `<prefix>-failed`                    | terminal failure                 |
| executed mirror      | `<prefix>-executed`                  | work finished, PR ready          |
| review-passed mirror | `<prefix>-review-passed`             | blind review passed, deployable  |

The human-facing `Status` property (`New → Build / Do → Review → Done …`) is
updated alongside tags via the per-phase status mapping, also configured per
instance. Individual tag names remain overridable per source (so an existing
`🤖 agent-*` convention can be adopted), but the derived `faktory-<slug>-*`
names are the default.

Each instance keeps its own state under `~/.faktory/<slug>/` (SQLite DB,
secrets, logs) and runs its own API/web/TUI on its own port.

## SQLite state

- `config` — key/value app config (selected source, concurrency, repo path…)
- `sources` — configured work sources (kind + JSON config, secrets by ref)
- `secrets` — oauth tokens / API keys (local file, `chmod 600`)
- `tasks` — one row per work item under management (phase, herdr ids, PR url…)
- `task_events` — append-only transition/audit log
- `herdr_events` — raw herdr events captured by the reconciler (for repair)

## Interfaces

1. **HTTP API** (`src/api`) — the control plane the orchestrator agent + web UI
   use. JSON over localhost. See `docs/API.md`.
2. **Web UI** (`src/web`) — connect Notion via OAuth, pick a data source +
   candidate filter, see the board. Static files served by the API server.
3. **TUI** (`src/tui`) — inspect + repair orchestration state from the terminal.
4. **Skills** (`skills/`) — teach the orchestrator agent how to drive Faktory +
   herdr (`faktory-orchestrator`, `faktory-dispatch`, `faktory-review`).

## herdr integration

Faktory speaks herdr's newline-delimited JSON socket (`HERDR_SOCKET_PATH`) for
queries/events, and shells the `herdr` CLI for interactive agent startup (which
handles readiness detection). Dispatch = `worktree.create` → `agent.start`
(kind from config) → `agent.prompt "/kickoff <url>"`. Monitoring subscribes to
`pane.agent_status_changed` and reconciles task phases.

**Attention.** herdr models agent status as `idle | working | blocked | done |
unknown`. Faktory treats `blocked` as "agent needs attention" → task phase
`blocked` + the `<prefix>-stalled` tag on the source item; `done` triggers
outcome inspection (`agent.read --source recent-unwrapped`). `agent.wait` /
`agent.prompt … wait:{until}` are server-owned and race-free (`agent_blocked`
is returned if the agent is already waiting on input), so the engine never
scrapes pane text to infer state.

## Installer & onboarding

Faktory ships a macOS installer (`install.sh` + `faktory setup`) so a fresh
machine needs nothing pre-installed:

1. **Bootstrap** (`install.sh`): installs Homebrew if missing, then `node`,
   `pnpm`, `herdr`, and `pi` (plus optional `claude`/`codex` harnesses).
2. **Defaults**: herdr always, pi always as the orchestrator harness.
3. **Auth wizard** (`faktory setup`): walks through authenticating pi against
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
