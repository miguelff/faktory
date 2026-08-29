# Faktory HTTP API

Localhost JSON control plane, served by `faktory serve` (default
`http://127.0.0.1:4600`). It is a thin, read-mostly surface: the board/feed for
viewers, and the **inbox** endpoint that dispatched agents use to talk back to
the engine loop (`faktory report` wraps it). All lifecycle policy — dispatch,
transitions, WIP, stall handling — lives in the in-process engine loop
(`src/core/loop.ts`), not here. The only writes callers make are inbox messages
and manual repair transitions.

| Method | Path                        | Body                                            | Effect |
|--------|-----------------------------|-------------------------------------------------|--------|
| GET    | `/api/health`               | —                                               | `{ ok, prefix, phases, stages }` |
| GET    | `/api/tasks`                | — (`?phase=` filter)                            | `{ tasks: Task[] }` |
| GET    | `/api/tasks/:id`            | —                                               | `{ task, events, inbox, stages }` |
| GET    | `/api/board`                | —                                               | `{ columns: { phase, tasks }[] }` (one per phase, priority-desc) |
| GET    | `/api/feed`                 | — (`?limit=` , default 50)                      | `{ feed: FeedEntry[] }` newest first |
| POST   | `/api/sync`                 | —                                               | pulls source candidates; `{ discovered: Task[] }` |
| POST   | `/api/tasks/:id/inbox`      | `{ type, sender?, stage?, note?, data? }`       | enqueue a typed message for the loop (the agent→loop channel). `type ∈ completed \| needs_human \| note`. `202` with `{ ok, message }`; the loop validates + applies it. `400` on a bad type/stage, `404` when unknown. |
| POST   | `/api/tasks/:id/transition` | `{ to, actor?, note?, force? }`                 | **manual repair only** — validated lifecycle move mirrored to the source; `force` bypasses validation (still audited). `409` on illegal moves, `400` on a bad phase. |
| POST   | `/api/tasks/:id/comment`    | `{ note?, agent?, status?, data? }`             | leaves a handoff-trail comment on the work unit. Returns `{ ok, body }` with the rendered marker. `400` when empty, `404` when unknown. |

`Task`: `{ id, sourceId, itemId, title, url, phase, priority, workspaceId,
paneId, agentName, stage, dispatchedAt, resumePhase, branch, prUrl, error,
createdAt, updatedAt }`. A lane task is *being worked* when `dispatchedAt`/
`agentName` are set, and *waiting* otherwise.

Phases: `backlog, to_shape, to_execute, to_review, ready, done, blocked,
archived` (see `src/core/lifecycle.ts` for the legal transitions). The three
actionable lanes — `to_shape, to_execute, to_review` — are the loop's inboxes.

## Inbox — the agent → loop channel

Agents never mutate state; they send typed messages and the loop (the single
coordinator) validates origin + transition legality and serially applies them
(Go-channel style: don't communicate by sharing memory, share memory by
communicating). `faktory report` is the agent-facing wrapper:

```
faktory report <id> --config <slug> --sender <agent> --stage <stage> \
  --type <completed|needs_human|note> --note "<summary>" [--data '<json>']
```

- `completed` — the stage is done; the loop advances the task to the next lane
  and injects the message's `note`/`data` (the handoff payload) into the next
  stage's prompt.
- `needs_human` — a human decision is required; the loop surfaces it in the feed
  and moves the task to `blocked` until answered.
- `note` — a handoff annotation with no transition.

Completion is **only** ever declared by a `completed` message, from the task's
current dispatched agent (unsigned/mismatched messages are rejected). A quiet
agent is reconciled against herdr state: herdr-`blocked` or `absent` → the task
is `blocked` for a human; `idle`/`done` with no message → nudged once, then only
*flagged* in the feed (an actionable lane like `to_shape` is a live human
conversation, so the session is never torn down on silence). Silence is never
read as success.

## Handoff trail

Inbox `note`/`data` are also persisted as a *handoff trail* on the work unit
(Notion page comments today) via the `WorkSource.comment` port. Each renders a
provider-agnostic marker:

```
<faktory agent="pi" status="to_execute" pr="123">Plan approved, executing.</faktory>
```

The marker is rendered in the domain (`src/core/handoff.ts`); each backend only
decides where comments live (`src/sources/types.ts`).
