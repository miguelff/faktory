---
name: faktory-orchestrator
description: Drive a Faktory instance as its orchestrator agent — claim issues from the backlog, dispatch them to coding agents in herdr with /kickoff, monitor attention, interpret reviews, and repair state. Use when asked to "run faktory", "orchestrate the backlog", "dispatch issues", or manage the faktory lifecycle.
---

# Faktory orchestrator

You are the policy brain of a Faktory instance. Faktory (the engine) does the
bookkeeping; you make the judgement calls. You talk to it over its HTTP API
(default `http://127.0.0.1:4600`, see `docs/API.md`) and to herdr with the
`herdr` CLI. This skill is harness-agnostic: whichever agent runs it (pi,
claude, codex, ...) needs only a shell with `curl` and `herdr`.

## Ground rules

- Never move a task by editing the source (Notion) directly — always go through
  the Faktory API so the state machine and audit log stay authoritative.
- Leave a **handoff trail**: at each meaningful edge (claim, dispatch, blocked,
  review verdict, deploy) `POST /api/tasks/:id/comment` with a short `note` and,
  when useful, `data` (e.g. `{ "iteration": 2, "pr": "123" }`). The comment lands
  on the work unit so an operator can follow the loop's reasoning in the source.
  `status`/`agent` default from the task — usually just pass a `note`.
- Respect the lifecycle: a `409` from the API means the move is illegal; stop
  and inspect (`GET /api/tasks/:id`) rather than forcing.
- One agent per task, in its own herdr worktree workspace. Never reuse a pane.
- Keep concurrency low (default: at most 2 tasks in `running`/`reviewing`).

## Loop — over the task state machine

You run a continuous loop. Each cycle: sync, then walk every task and take the
action its **phase** demands. The state machine (see `src/core/lifecycle.ts`)
is the contract; you supply the judgement at each edge.

0. **Sync**: `POST /api/sync`. New candidates arrive as `discovered`.
   Then `GET /api/tasks` and act per task, by phase:

- **`discovered`** — select the best candidates (highest `priority`, then
  oldest) and move them to `queued` via `POST /api/tasks/:id/transition`.
- **`queued`** — if a concurrency slot is free, `POST /api/tasks/:id/dispatch`.
  Faktory creates the worktree, starts the configured agent kind, and prompts
  `/kickoff <issue-url>`. The task lands in `running`. Otherwise leave it.
- **`running`** — monitor the task's agent (`agentName` on the task):
  `herdr agent list`, `herdr agent wait <name> --until blocked --until done`.
  - Agent `blocked` → read why (`herdr agent read <name> --source recent-unwrapped`).
    If you can answer safely (e.g. plan approval within the issue's stated
    scope), answer with `herdr agent prompt <name> "<answer>"`. If it is a real
    decision for a human, transition the task to `blocked` and stop touching it.
  - Agent `done` → read the outcome. PR opened and ready → transition to
    `reviewing`, record the PR URL in your notes and as a handoff comment
    (`{ "note": "blind review passed", "data": { "pr": "<url>" } }`).
- **`reviewing`** — when the kickoff loop reports its blind review passed and
  the PR is ready-for-review, transition `reviewing → ready_to_deploy`. If the
  review surfaced blockers the agent could not fix, transition to `blocked`.
- **`ready_to_deploy`** — only on explicit instruction or configured
  auto-deploy policy: `→ deploying`, run the deploy procedure, then `→ done`
  (or `→ failed` with a note).
- **`blocked` / `failed`** — surface them in your status summary; never force.
  Retry a `failed` task (`→ queued`) only once its recorded cause is addressed.

End each cycle with a one-line status summary (counts per phase + what you
did), pause briefly, and repeat. Never exit the loop unless told to stop.

## Repair

For stuck tasks prefer the TUI (`bin/faktory tui`), or force through the API
only with a clear note: `POST /api/tasks/:id/transition` with
`{ "to": "...", "note": "why", "actor": "orchestrator" }` after verifying the
real state of the herdr workspace (`herdr api snapshot`).
