# ⚙ Faktory

Local orchestration for coding agents. Faktory watches an issue backlog
(Notion today; Jira/GitHub behind the same abstraction), dispatches issues to
coding agents running inside [herdr](https://herdr.dev) via `/kickoff`, tracks
the whole lifecycle (dispatch → execution → review → deploy) in SQLite, and
mirrors progress back to the source through faktory-managed ownership columns.

Read `docs/DESIGN.md` for the architecture and `AGENTS.md` if you are an agent
evolving this codebase.

## Install

On a fresh Mac:

```sh
./install.sh          # Homebrew, node, pnpm, herdr, pi (+ optional claude/codex)
pnpm install
```

Already have node ≥ 24 and herdr? Just `pnpm install`.

## Configure

Faktory is organized in **configs** — independent orchestrations, each with its
own state database, secrets, port, and owner id (`faktory-<slug>`) under
`~/.faktory/<slug>/`. You normally never configure anything by hand: the first
`bin/faktory serve` walks you through a terminal wizard — authenticate with
Notion (OAuth in the browser when
`FAKTORY_NOTION_CLIENT_ID`/`FAKTORY_NOTION_CLIENT_SECRET` are set, otherwise an
integration token), then pick the backlog database **or let faktory create
one**, then repo/harness/port defaults. Re-run the wizard any time with
`bin/faktory setup`.

Scripted setup is still available:

```sh
bin/faktory source set-notion \
  --config omnia \
  --database 328433c39871805dace6eae8987ce6c3 \
  --priority-property Priority \
  --token ntn_xxx            # or NOTION_TOKEN env var
```

**Ownership model.** Faktory manages three columns on the database — added
automatically if missing: `faktory_status` (select), `faktory_owned_by`
(rich text), and `faktory_owned_at` (date). Every entry is *discoverable* by
every faktory instance consuming the database; an instance **owns** an entry
the moment it moves it away from discoverable, stamping `faktory_owned_by` +
`faktory_owned_at` via compare-and-swap — a lost race cancels the local task.
Only the owner manages the entry from then on, mirroring its lifecycle phase
into `faktory_status`. Share the database with your Notion integration or the
API returns 404.

Optional per-config settings (stored in the config's state DB) are read/written
with `config get`/`config set`:

```sh
bin/faktory config set repoCwd /path/to/repo --config omnia  # where /kickoff worktrees are cut
bin/faktory config set agentKind pi          --config omnia  # harness that runs /kickoff
bin/faktory config get                       --config omnia  # print all settings
```

Keys: `repoCwd`, `agentKind`, `orchestratorKind`, `port`, `herdrSession`.

## Collaborate

Several operators can drive **one shared datasource** (a single Notion backlog)
from their own machines. Each runs an independent config with its own slug, so
its owner id (`faktory-<slug>`) is distinct: every entry in the database is
discoverable by everyone, and an operator only manages the entries their config
claims via `faktory_owned_by` (compare-and-swap — a lost race cancels the local
task). Nothing else is shared: state DBs, secrets, ports, and herdr sessions
stay per-config and local.

Onboarding a teammate is two commands:

```sh
# on the operator who already has the datasource configured
bin/faktory invite            # picks the only config, or asks; prints one string
bin/faktory invite omnia      # a specific config

# on the teammate, with the string you sent them
bin/faktory join <string>     # sets up a new local config linked to that datasource
```

`invite` prints a single opaque string that models the config's datasource: the
source kind, its adapter config (e.g. the Notion database id + priority
mapping), and the access token needed to reach it. **The string embeds a
secret** — share it over a trusted channel (password manager, DM), never commit
it. Guidance and the warning are printed to stderr, so `bin/faktory invite >
invite.txt` captures just the string.

`join` decodes the string and runs a short setup: pick a config name (its own
owner id), confirm dispatch defaults, done — the datasource, credentials, and
ownership columns come from the invite. It **bails if a local config already
links that datasource**, so you never end up with two configs fighting over the
same backlog under different owner ids on one machine. Because each joiner gets
a distinct `faktory-<slug>` prefix, claims never collide across operators.

## Run

**One command** — Faktory spawns herdr, not the other way around:

```sh
bin/faktory serve              # picks the only config, or asks; wizard on first run
bin/faktory serve omnia        # a specific config (equivalent: --config omnia)
```

`serve` first makes sure a config exists (running the setup wizard if not, or
letting you pick when several exist), then checks/installs external
dependencies, starts the web board + API in-process, and bootstraps the whole
workbench. From a plain terminal it opens a new terminal window attached to a
herdr session **dedicated to that config** (`faktory-<slug>`, isolated from
every other config's session; `--session`/`herdrSession` config to change)
and sets up a `faktory:<instance>` workspace there; from
inside a herdr pane it splits the panes around itself. Either way you get a
TUI pane and an **orchestrator agent loop** — an agent (configurable harness,
`orchestratorKind` config, pi by default) that follows
`skills/faktory-orchestrator/SKILL.md` and continuously loops over the task
state machine: sync → queue discovered → dispatch queued → monitor running →
judge reviews. Re-running `serve` against a live session preserves panes and
restarts the loop only if its agent died. Opt out with `--headless`,
`--no-tui`, or `--no-agent`; `bin/faktory orchestrate` (re)starts just the
agent loop.

Other commands:

```sh
bin/faktory task sync --config omnia          # pull candidates into the task table
bin/faktory task list --config omnia          # list tasks (alias: task ls)
bin/faktory tui       --config omnia          # inspect / repair in the terminal
bin/faktory invite omnia                     # share this config's datasource
bin/faktory join   <string>                  # link a new config to a shared datasource
```

Manage the configs themselves (CRUD):

```sh
bin/faktory config list                      # list configs (prefix, port, backlog db)
bin/faktory config create [name]             # create one (runs the setup wizard)
bin/faktory config delete omnia              # delete a config + its local state (asks first)
bin/faktory config delete omnia --force      # …without the confirmation prompt
```

Deleting a config removes its state under `~/.faktory/<slug>/` (SQLite DB and
secrets); it leaves Notion ownership tags on already-claimed items untouched.
The `serve` picker can also delete a config when several exist.

- **Web board**: http://127.0.0.1:4600 — sync, queue, dispatch, watch phases.
- **HTTP API**: `docs/API.md` — same control plane, used by orchestrator agents.
- **TUI**: j/k navigate, enter for detail + audit history, `t` to transition,
  SHIFT+letter to force-repair a stuck task, `s` sync, `q` quit.
- **Dispatch** requires running inside herdr (`HERDR_SOCKET_PATH` set): it
  creates a git worktree (`faktory-<slug>/<task>-<title>` branch), starts an
  agent in the new workspace pane, and prompts it with `/kickoff <issue-url>`.

## CLI

The CLI is built on [Commander](https://github.com/tj/commander.js): every
command is self-describing, so help and usage are generated (never
hand-maintained) and stay in sync with behavior. It is **non-interactive by
default** — running `bin/faktory` with no arguments prints the subcommands and
options and exits, instead of doing anything:

```sh
bin/faktory                 # list subcommands + global options
bin/faktory <command> -h    # options for one command (e.g. bin/faktory task transition -h)
```

Every config-scoped command takes `-c, --config <name>` (the deprecated
`-i, --instance` is a hidden alias). Command surface:

| Command | What it does |
|---------|--------------|
| `serve [config]` | set up if needed, then start everything (API, board, herdr, TUI, orchestrator) |
| `setup` | run the setup wizard standalone |
| `config list\|create\|delete` | manage configs (named orchestrations) |
| `config get\|set` | read/write a config's settings |
| `source set-notion` | configure the Notion source non-interactively |
| `task sync\|list\|transition` | pull candidates, list tasks, move a task through the lifecycle |
| `tui` | terminal inspector / repair |
| `orchestrate` | (re)start just the orchestrator agent loop |
| `invite` / `join` | share / link a datasource across operators |

Adding a command is one file under `src/cli/commands/` plus one register call
in `src/cli/index.ts` (see `AGENTS.md` → "CLI structure").

## Lifecycle

```
discovered → queued → dispatching → running → reviewing → ready_to_deploy → deploying → done
                          ↘ failed (retry → queued)   ↘ blocked (needs a human)
```

Every transition is validated against the state machine and recorded in the
`task_events` audit log. Illegal jumps are rejected; repairs are possible but
always marked `[forced]`.

## Test

```sh
pnpm typecheck
pnpm test        # unit + integration (fake Notion API, fake herdr socket, real SQLite + HTTP)
```

Integration coverage: Notion adapter against a fake Notion server (pagination,
filters, claim CAS, status mirroring), the HTTP API against a real server on an
ephemeral port with a fake source (lifecycle + source mirroring), and the herdr
client against a fake unix-socket server (round trips, errors, event streams).

## Contribute

- Read `AGENTS.md` (house rules + the vendored Domain-Driven Hexagon guideline).
- New work source? Implement `WorkSource` in `src/sources/<kind>.ts`, register
  it in `src/sources/factory.ts`, add mapping tests + a fake-server integration
  test. The engine must not change.
- UI changes must apply the vendored design skills in `.agents/skills/`
  (`web-design-guidelines` for the web, `terminal-ui` for the TUI).
- `pnpm typecheck && pnpm test` must pass before any PR.
