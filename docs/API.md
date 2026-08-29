# Faktory HTTP API

Localhost JSON control plane, served by `faktory serve` (default
`http://127.0.0.1:4600`). Used by the web UI and by orchestrator agents.

| Method | Path                        | Body                                            | Effect |
|--------|-----------------------------|-------------------------------------------------|--------|
| GET    | `/api/health`               | —                                               | `{ ok, prefix, phases }` |
| GET    | `/api/tasks`                | — (`?phase=` filter)                            | `{ tasks: Task[] }` |
| GET    | `/api/tasks/:id`            | —                                               | `{ task, events, dependencies }` (audit trail + depends-on status) |
| POST   | `/api/sync`                 | —                                               | pulls source candidates; `{ discovered: Task[] }` |
| POST   | `/api/tasks/:id/transition` | `{ to, actor?, note? }`                         | validated lifecycle move, mirrored to the source (tags + status). `409` on illegal moves, and on `discovered → queued` when the task has unmet dependencies (body includes `blockers`). |
| POST   | `/api/tasks/:id/comment`    | `{ note?, agent?, status?, data? }`             | leaves a handoff-trail comment on the work unit. `agent` defaults to the task's agent name, `status` to its mirrored phase; `data` are extra marker attributes. Returns `{ ok, body }` with the rendered marker. `400` when empty, `404` when the task is unknown. |
| POST   | `/api/tasks/:id/dispatch`   | `{ agentKind?, repoCwd?, repoWorkspaceId?, kickoffCommand? }` | worktree.create → agent.start → `/kickoff <url>`; task → `running`. `503` when not inside herdr. |

`Task`: `{ id, sourceId, itemId, title, url, phase, priority, workspaceId,
paneId, agentName, branch, prUrl, error, createdAt, updatedAt }`.

## Dependencies ("depends-on")

A task may depend on other work items; it can only be queued once every
dependency is finished, so an ordered backlog is worked in order. `GET
/api/tasks/:id` returns a `dependencies` array of `{ itemId, title, phase,
status, satisfied }` — one entry per depends-on edge. A dependency is
`satisfied` when it is `done` (a local task in phase `done`, or the source
reporting `faktory_status = done`). Attempting `POST
/api/tasks/:id/transition` to `queued` while any dependency is unsatisfied
returns `409` with `{ error, blockers }` (the unmet `dependencies` entries) and
changes nothing — no ownership is claimed. Sources model the relation natively
(Notion: the `faktory_depends_on` relation property).

Phases: `discovered, queued, dispatching, running, reviewing, blocked,
ready_to_deploy, deploying, done, failed, cancelled` (see
`src/core/lifecycle.ts` for the legal transitions).

## Handoff trail

`POST /api/tasks/:id/comment` leaves a *handoff trail* on the work unit — the
loop's decisions become comments the operator can read in the source (Notion
page comments today). Each comment renders a provider-agnostic marker:

```
<faktory agent="pi" status="running" iteration="2">Plan approved, executing.</faktory>
```

`agent`/`status` come first (defaulting from the task); any `data` keys follow
as extra attributes. Commenting is part of the `WorkSource` port
(`src/sources/types.ts`), so every backend implements where comments live; the
marker itself is rendered in the domain (`src/core/handoff.ts`).
