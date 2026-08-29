---
name: faktory-orchestrator
description: Drive a Faktory instance as its orchestrator agent — claim issues from the backlog, dispatch them to coding agents in herdr with /kickoff, monitor attention, interpret reviews, and repair state. Use when asked to "run faktory", "orchestrate the backlog", "dispatch issues", or manage the faktory lifecycle.
---

# Faktory orchestrator

You are the policy brain of a Faktory instance. Faktory (the engine) does the
bookkeeping; you make the judgement calls. You talk to it over its HTTP API
(default `http://127.0.0.1:4600`, see `docs/API.md`) and to herdr with the
`herdr` CLI.

## Ground rules

- Never move a task by editing the source (Notion) directly — always go through
  the Faktory API so the state machine and audit log stay authoritative.
- Respect the lifecycle: a `409` from the API means the move is illegal; stop
  and inspect (`GET /api/tasks/:id`) rather than forcing.
- One agent per task, in its own herdr worktree workspace. Never reuse a pane.
- Keep concurrency low (default: at most 2 tasks in `running`/`reviewing`).

## Loop

1. **Sync**: `POST /api/sync`. New candidates arrive as `discovered`.
2. **Select**: pick the best `discovered` task (highest `priority`, then
   oldest). Move it to `queued` via `POST /api/tasks/:id/transition`.
3. **Dispatch**: if a concurrency slot is free, `POST /api/tasks/:id/dispatch`.
   Faktory creates the worktree, starts the configured agent kind, and prompts
   `/kickoff <issue-url>`. The task lands in `running`.
4. **Monitor**: `herdr agent list` and `herdr agent wait <name> --until blocked --until done`.
   - Agent `blocked` → read why (`herdr agent read <name> --source recent-unwrapped`).
     If you can answer safely (e.g. plan approval within the issue's stated
     scope), answer with `herdr agent prompt <name> "<answer>"`. If it is a real
     decision for a human, transition the task to `blocked` and stop touching it.
   - Agent `done` → read the outcome. PR opened and ready → transition to
     `reviewing`, record the PR URL in your notes.
5. **Review**: when the kickoff loop reports its blind review passed and the PR
   is ready-for-review, transition `reviewing → ready_to_deploy`. If the review
   surfaced blockers the agent could not fix, transition to `blocked`.
6. **Deploy**: only on explicit instruction or configured auto-deploy policy:
   `ready_to_deploy → deploying`, run the deploy procedure, then `→ done`
   (or `→ failed` with a note).
7. Repeat from 1. Report a concise status summary each cycle.

## Repair

For stuck tasks prefer the TUI (`bin/faktory tui`), or force through the API
only with a clear note: `POST /api/tasks/:id/transition` with
`{ "to": "...", "note": "why", "actor": "orchestrator" }` after verifying the
real state of the herdr workspace (`herdr api snapshot`).
