---
name: kickoff
description: Start a new Faktory development task from an issue link in an operator-prepared feature worktree, then run a plan / execute / blind-review loop that ends with a ready-for-review PR (or a review-clean local branch when no remote exists). Use when the user says "kickoff" or "/kickoff <url>".
disable-model-invocation: true
---

# Kickoff (faktory repo)

Full lifecycle for one task in the **faktory** repository: worktree validation,
issue-driven planning, incremental execution, blind review (max 3 iterations),
then a ready-for-review PR — or, when the repo has no remote, a review-clean
local branch plus a final report.

## Ground rules (apply throughout)

- Read `AGENTS.md` first and comply with it (hexagonal boundaries, lifecycle as
  data, no new runtime deps, design skills for UI work).
- Never make breaking or hard-to-reverse decisions (schema, lifecycle table,
  public API shapes) without asking first.
- Report failures honestly; never paper over a failing test.

## Phase 0: Setup

Assume an operator (Faktory) already created and entered a dedicated worktree.

1. `git branch --show-current` — bail if detached or on `main`.
2. If a remote `origin` exists: `git fetch origin main` and fast-forward with
   `git merge --ff-only origin/main`; bail on failure. If there is **no
   remote**, use local `main` as the base and note that the PR step will be
   skipped.
3. Bail if the worktree is dirty or the branch has commits not on the base.
4. Get the issue link from the invocation (`/kickoff <url>`); fetch and read it
   (Notion API token available via instance config, or ask the operator).
5. Play back problem, success criteria, and out-of-scope in a few sentences;
   proceed if unambiguous, otherwise ask.

## Phase 1: Plan

- Ask clarifying questions until requirements are unambiguous.
- Present consequential design decisions as options with a recommendation.
- Decide test coverage up front: unit for domain logic, integration (fake
  server / real SQLite / ephemeral port) for adapters and API — matching the
  existing patterns in `test/`.

## Phase 2: Execute (iteration N)

- Implement in coherent Conventional Commits (`type(scope): summary`).
- Write tests with the code, not after.
- Before finishing an iteration: `pnpm typecheck && pnpm test` must pass.
- With a remote: push and open a DRAFT PR against `main` on the first
  iteration; push fixes to it later. Without a remote: keep committing locally.

## Phase 3: Blind review

The reviewer must have NO access to this conversation — only the diff
(`git diff main...HEAD`), the issue description, and instructions to review for
correctness, edge cases, test coverage, AGENTS.md compliance, and simplicity.

Inside herdr (`test "${HERDR_ENV:-}" = 1`): split a sibling pane
(`herdr pane split --current --cwd "$PWD" --no-focus`), start the same agent
kind there (`herdr agent start reviewer --kind <kind> --pane <id>`), prompt it
with `herdr agent prompt reviewer "<prompt>" --wait`, and read findings with
`herdr agent read reviewer --source recent-unwrapped`. Release stale reviewers
between iterations. Outside herdr: use a subagent.

Collect findings as a numbered list with severity: blocker / should-fix / nit.

## Phase 4: Loop control

- Blockers or should-fix items and iterations < 3 → fix (Phase 2, N+1), re-review.
- Exit when a pass returns only nits, or after 3 iterations (listing anything
  unresolved).

## Phase 5: Finish

- With a remote: mark the PR ready for review.
- Post a final summary: what was built, key decisions, review iterations,
  limitations. Faktory's orchestrator uses this to move the task to
  `reviewing`.
