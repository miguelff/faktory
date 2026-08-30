# Faktory HTTP API

Localhost JSON control plane, served by `faktory serve` (default
`http://127.0.0.1:4600`). It is a thin, read-mostly surface: the board/feed for
viewers, and the **inbox** endpoint that dispatched agents use to talk back to
the engine loop (`faktory report` wraps it). All lifecycle policy — dispatch,
transitions, handoffs, dispatch retries — lives in the in-process engine loop
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
| POST   | `/api/tasks/:id/inbox`      | `{ type, sender?, stage?, note?, data? }`       | enqueue a typed message for the loop (the agent→loop channel). `type ∈ handoff \| note` (`handoff` routes to `data.to`). `202` with `{ ok, message }`; the loop validates + applies it. `400` on a bad type/stage, `404` when unknown. |
| POST   | `/api/tasks/:id/transition` | `{ to, actor?, note?, force? }`                 | **manual repair only** — validated lifecycle move mirrored to the source; `force` bypasses validation (still audited). `409` on illegal moves, `400` on a bad phase. |
| POST   | `/api/tasks/:id/comment`    | `{ note?, from?, to?, data? }`                  | leaves a `<handoff from to>` papertrail comment on the work unit. Returns `{ ok, body }` with the rendered marker. `400` when empty, `404` when unknown. |

`Task`: `{ id, sourceId, itemId, title, url, phase, priority, workspaceId,
paneId, agentName, stage, dispatchedAt, branch, prUrl, error,
createdAt, updatedAt }`. A lane task is *being worked* when `dispatchedAt`/
`agentName` are set, and *waiting* otherwise.

Phases: `backlog, shape, execute, review, release, done, blocked,
archived` (see `src/core/lifecycle.ts` for the legal transitions). The four
actionable lanes — `shape, execute, review, release` — are the loop's inboxes.
Only a human moves `backlog → shape` and `done → archived`.

## Inbox — the agent → loop channel

Agents never mutate state; they send typed messages and the loop (the single
coordinator) validates origin + transition legality and serially applies them
(Go-channel style: don't communicate by sharing memory, share memory by
communicating). `faktory report` is the agent-facing wrapper:

```
faktory report <id> --config <slug> --sender <agent> --stage <stage> \
  --type <handoff|note> --note "<summary>" --to <lane> [--data '<json>']
```

- `handoff` — the one state-changing message: move the task to the lane named
  by `--to` (folded into `data.to`), the note/data becoming the payload the
  next role's prompt is seeded with. The straight pipeline is a handoff to the
  next lane (shape → execute, execute → review, review → release,
  release → done); review → execute routes rework back; shape → backlog parks
  a task on the human's word; execute/review/release → blocked when only a
  human can resolve something (the loop opens an interactive unblocking
  session seeded with the note); blocked → its lane on resolution. Human-only
  moves (backlog → shape, done → archived) are rejected, and `shape` cannot
  hand off to blocked — it is already an interactive session with the human.
- `note` — a papertrail annotation with no transition.

A task only ever advances on a `handoff` from its *current dispatched* agent
(unsigned/mismatched messages are rejected) — never on silence. Every session
is interactive: agents ask the human directly in their herdr tab, and herdr
itself surfaces an agent that is waiting for input, so the loop never nudges,
flags, or tears down a quiet session.

## Handoff papertrail

Every applied inbox message is mirrored onto the work unit (Notion page
comments today) via the `WorkSource.comment` port, so the task accumulates a
feed of handoffs — the papertrail. Each renders a provider-agnostic marker:

```
<handoff from="review" to="execute" agent="pi" pr="123">Blocker: missing tests.</handoff>
```

The marker is rendered in the domain (`src/core/handoff.ts`); each backend only
decides where comments live (`src/sources/types.ts`).
