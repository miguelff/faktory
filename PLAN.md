# PLAN — Faktory roadmap

Task backlog for evolving Faktory. Each entry is written so it can be created
as an issue in the work source and dispatched **through Faktory itself** —
every database entry is discoverable; an instance claims it (CAS on
`faktory_owned_by`) when it queues it. Status legend: ☐ todo · ◐ partial · ☑ done.

## v0 (shipped)

- ☑ Work-source abstraction (abstract factory) + Notion adapter
  (candidacy = database + property + value; tag/status write-back; pagination;
  convention-tag provisioning on setup)
- ☑ Instance model — multiple named instances, `faktory-<slug>` tag prefix,
  state under `~/.faktory/<slug>/`
- ☑ SQLite state + lifecycle state machine with audit trail (`task_events`)
- ☑ herdr socket client (NDJSON) + dispatcher
  (worktree.create → agent.start → `/kickoff <url>`)
- ☑ HTTP control plane (`docs/API.md`) + web board + repair TUI
- ☑ macOS installer (`install.sh`), orchestrator skill, vendored design skills
- ☑ 31 unit/integration tests

## v1.5 — programmatic engine loop (shipped)

- ☑ **Replace the prompt-driven orchestrator agent with a deterministic engine
  loop** (`src/core/loop.ts`, run in `serve`). New pipeline
  `backlog → to_shape → to_execute → to_review → ready → done` (+ blocked,
  archived). Typed **inbox** channel (`faktory report` → API) for agent→loop
  messages; loop validates origin + legality, reconciles herdr state, never
  infers completion from silence. Per-task herdr space, one tab per stage;
  archive closes the space. **TUI kanban board + action feed.** Web UI removed
  (Notion is the remote board). This subsumes the v1 reconciler/auto-dispatch
  and the v2 orchestrator-agent bootstrap items below.

## v1 — close the loop (priority order)

1. ☐ **Reconciler in `serve`** — subscribe to `pane.agent_status_changed` /
   `pane.closed`; map agent `blocked` → task `blocked` (mirrored to `faktory_status`),
   `done` → outcome inspection → `reviewing`; persist raw events in
   `herdr_events`; recover from socket drops via `session.snapshot`.
   *Acceptance: kill/​block an agent mid-task and watch the board update
   without human input.*
2. ☐ **PR detection** — after kickoff finishes, capture the PR URL (from
   `agent.read --source recent-unwrapped` or `gh pr view --json url`) into
   `tasks.pr_url`. *Acceptance: PR link visible on board + in Notion.*
3. ☑ **Setup wizard in `faktory` itself** — `faktory serve [config]` is the
   whole product: terminal wizard on first run (Notion OAuth via
   FAKTORY_NOTION_CLIENT_ID/SECRET or token paste, token verification, pick
   **or create** the backlog database, candidacy/status/priority mapping, tag
   provisioning), config picker when several exist, then serve. `--instance`
   renamed to `--config`; `init` removed (`source set-notion` auto-creates).
   *(CLI refactor: bare `faktory` now prints subcommands+options rather than
   serving — start with `faktory serve`.)*
4. ☐ **Notion OAuth flow in the web UI** — public integration; store tokens in
   the instance secret store; datasource picker replaces manual
   `source:set-notion` flags. (CLI-side OAuth shipped with the wizard.)
5. ☑ **Auto-dispatch policy** — superseded by the engine loop: it promotes
   `backlog` (priority order) to keep the actionable lanes fed up to `wip`
   (config, default 3) and dispatches a stage agent per lane. (A `Blocked By`
   relation gate is still a future refinement.)
6. ☐ **Deploy hook** — per-instance `deployCommand`; `ready_to_deploy →
   deploying → done/failed` runs it in a herdr pane with output captured.

## v2 — breadth

- ☐ **GitHub work source** — repo + issues search query as candidacy; labels as
  tags; status via label conventions. Factory registration only, engine untouched.
- ☐ **Jira work source** — JQL candidacy, label mirrors.
- ☐ **Task detail page in web UI** — audit trail, live pane read (via API
  proxy to `pane.read`), links to herdr workspace.
- ☑ **Orchestrator agent bootstrap** — `faktory serve` bootstraps the whole
  workbench inside herdr (TUI pane + orchestrator agent loop pane), and
  `faktory orchestrate` (re)starts just the agent. The harness is abstract
  (`orchestratorKind` config, pi by default); the loop itself lives in the
  `faktory-orchestrator` skill, prompted with the skill path + instance API URL.
- ☐ **Multi-source instances** — several sources per instance (`sources` table
  already allows it; CLI/API assume `primary` today).
- ☐ **Blind-review evidence** — persist review iterations/findings from the
  kickoff loop in `task_events` for the board.

## Engineering debt / hardening

- ☑ **CLI refactor** — command registry over Commander (`src/cli/`, one file per
  command); self-documenting help, non-interactive by default (bare `faktory`
  lists subcommands), colon commands made consistent (`source set-notion`,
  `config get`/`config set`). Adding a command = one file + one register call.
  *Behavior note:* command groups now require an explicit subcommand — bare
  `faktory config` / `faktory source` print their subcommands instead of
  defaulting to `list` (use `faktory config list`).
- ☐ Port allocation per instance (config `port`, collision check).
- ☐ Auth on the HTTP API (localhost token header) before any non-localhost use.
- ☐ Graceful shutdown of `serve` (close SQLite, unsubscribe).
- ☐ E2E smoke test inside a real herdr session (spawn scratch workspace,
  fake agent kind) gated behind `FAKTORY_E2E=1`.
- ☐ Replace `node:sqlite` experimental-flag reliance check when Node marks it stable.
