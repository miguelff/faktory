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
| POST   | `/api/tasks/:id/dispatch`   | `{ agentKind?, repoCwd?, repoWorkspaceId?, kickoffCommand? }` | worktree.create → agent.start → `/kickoff <url>`; task → `running`. `503` when not inside herdr. |

`Task`: `{ id, sourceId, itemId, title, url, phase, priority, workspaceId,
paneId, agentName, branch, prUrl, error, createdAt, updatedAt }`.

Phases: `discovered, queued, dispatching, running, reviewing, blocked,
ready_to_deploy, deploying, done, failed, cancelled` (see
`src/core/lifecycle.ts` for the legal transitions).
