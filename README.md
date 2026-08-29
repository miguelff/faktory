# ⚙ Faktory

Local orchestration for coding agents. Faktory watches an issue backlog
(Notion today; Jira/GitHub behind the same abstraction), dispatches issues to
coding agents running inside [herdr](https://herdr.dev) via `/kickoff`, tracks
the whole lifecycle (dispatch → execution → review → deploy) in SQLite, and
mirrors progress back to the source with tags and statuses.

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

Faktory is organized in **instances** — independent orchestrations with their
own state, port, and tag prefix (`faktory-<slug>`). Create one and point it at
a Notion database:

```sh
bin/faktory init omnia
bin/faktory source:set-notion \
  --instance omnia \
  --database 328433c39871805dace6eae8987ce6c3 \
  --candidate-property Tags \
  --candidate-value "faktory-omnia-execute" \
  --status-property Status \
  --priority-property Priority \
  --token ntn_xxx            # or NOTION_TOKEN env var
```

Candidacy is a *property + value* filter: any page whose `Tags` contains
`faktory-omnia-execute` becomes a Faktory task. Lifecycle mirrors are written
back as `faktory-omnia-processing`, `-stalled`, `-failed`, `-executed`,
`-review-passed`. Share the database with your Notion integration or the API
returns 404.

Optional per-instance settings (stored in the instance DB):

```sh
# where /kickoff worktrees are created from, and which agent runs them
bin/faktory transition --help   # see CLI usage
```

## Run

```sh
bin/faktory sync   --instance omnia          # pull candidates into the task table
bin/faktory tasks  --instance omnia          # list tasks
bin/faktory serve  --instance omnia --port 4600 --repo-cwd ~/GitHub/useomnia/omnia --agent-kind pi
bin/faktory tui    --instance omnia          # inspect / repair in the terminal
```

- **Web board**: http://127.0.0.1:4600 — sync, queue, dispatch, watch phases.
- **HTTP API**: `docs/API.md` — same control plane, used by orchestrator agents.
- **TUI**: j/k navigate, enter for detail + audit history, `t` to transition,
  SHIFT+letter to force-repair a stuck task, `s` sync, `q` quit.
- **Dispatch** requires running inside herdr (`HERDR_SOCKET_PATH` set): it
  creates a git worktree (`faktory-<slug>/<task>-<title>` branch), starts an
  agent in the new workspace pane, and prompts it with `/kickoff <issue-url>`.

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
filters, tag read-modify-write), the HTTP API against a real server on an
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
