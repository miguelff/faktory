# Faktory HTTP API

Localhost JSON control plane, served by `faktory serve` (default
`http://127.0.0.1:4600`). Used by the web UI and by orchestrator agents.

| Method | Path                        | Body                                            | Effect |
|--------|-----------------------------|-------------------------------------------------|--------|
| GET    | `/api/health`               | —                                               | `{ ok, prefix, phases }` |
| GET    | `/api/tasks`                | — (`?phase=` filter)                            | `{ tasks: Task[] }` |
| GET    | `/api/tasks/:id`            | —                                               | `{ task, events }` (audit trail) |
| POST   | `/api/sync`                 | —                                               | pulls source candidates; `{ discovered: Task[] }` |
| POST   | `/api/tasks/:id/transition` | `{ to, actor?, note? }`                         | validated lifecycle move, mirrored to the source (tags + status). `409` on illegal moves. |
| POST   | `/api/tasks/:id/comment`    | `{ note?, agent?, status?, data? }`             | leaves a handoff-trail comment on the work unit. `agent` defaults to the task's agent name, `status` to its mirrored phase; `data` are extra marker attributes. Returns `{ ok, body }` with the rendered marker. `400` when empty, `404` when the task is unknown. |
| POST   | `/api/tasks/:id/dispatch`   | `{ agentKind?, repoCwd?, repoWorkspaceId?, kickoffCommand? }` | worktree.create → agent.start → `/kickoff <url>`; task → `running`. `503` when not inside herdr. |

`Task`: `{ id, sourceId, itemId, title, url, phase, priority, workspaceId,
paneId, agentName, branch, prUrl, error, createdAt, updatedAt }`.

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
