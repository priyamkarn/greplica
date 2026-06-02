---
name: greplica-update-working-memory
description: Update Greplica working memory from the current coding-agent session, recent code changes, and durable decisions. Use only when the user explicitly invokes greplica-update-working-memory or asks to update working memory.
disable-model-invocation: true
---

# Update Greplica Working Memory

Update working memory with durable information learned during this coding session.

## Preconditions

Run from the target repository root or any subdirectory inside it.

1. Run `greplica doctor`.
2. If `greplica` is missing, tell the user to run the Greplica setup prompt from the README.
3. If `OPENAI_API_KEY` is missing, stop. Do not ask the user to paste the key into chat. Tell them to set it in their shell before launching the coding agent, or in repo-root `.env.local`.

`greplica` automatically prepares repo memory state; do not ask the user to run a separate initialization command.

## Gather Evidence

Use the current conversation/session context plus code evidence. Read:

- `git status --short`
- `git diff --stat`
- focused `git diff` for changed areas
- files touched by the session when needed to verify claims
- existing relevant memory with `greplica graph context "<task or changed area>"`

Use the current session as context, but verify durable code facts against files or diffs when possible.

## What To Store

Create memory for durable changes only:

- architectural decisions made during the session
- important new or changed flows/components
- risks, questions, or follow-up tasks that future agents should know
- facts that would save a future agent from rediscovering session context
- superseding claims when an old claim is known to be stale

Do not store:

- temporary debugging chatter
- every implementation detail
- command logs
- secrets or environment variable values
- obvious local code facts that a future agent can read immediately
- claims based only on vague conversation unless marked `unknown`

## Proposal Format

Write a JSON proposal to a temporary file:

```json
{
  "title": "Update working memory from session",
  "summary": "Durable context learned during the current coding session.",
  "creates": {
    "components": [],
    "flows": [],
    "claims": [
      {
        "id": "claim.example_session_decision",
        "kind": "decision",
        "text": "The session decided to keep the CLI primitive-focused and put workflows in coding-agent skills.",
        "truth": "source_verified",
        "intent": "intended",
        "about": []
      }
    ],
    "sources": [
      {
        "id": "source.current_session",
        "kind": "session",
        "ref": "Current coding-agent session",
        "title": "Current coding-agent session"
      }
    ],
    "edges": [
      {
        "kind": "evidenced_by",
        "from": "claim.example_session_decision",
        "to": "source.current_session",
        "metadata": {
          "reason": "The decision was discussed and agreed during the current coding-agent session."
        }
      }
    ]
  }
}
```

Allowed claim kinds: `fact`, `requirement`, `decision`, `task`, `question`, `risk`.
Allowed truth values: `code_verified`, `source_verified`, `unknown`.
Allowed intent values: `intended`, `accidental`, `unknown`.
Allowed source kinds: `session`.

Use compact relationship fields where possible:

- `flow.touches[]` for Flow -> Component.
- `component.contains[]` for Component -> Component.
- `flow.contains[]` for Flow -> Flow.
- `claim.about[]` for Claim -> Component/Flow.
- `claim.supersedes[]`, `component.supersedes[]`, or `flow.supersedes[]` only when replacing known existing memory.

For source-backed claims, use explicit `edges[]` entries with `kind: "evidenced_by"` and `metadata.reason`. Do not use compact `claim.evidenced_by[]`; every evidence edge must explain why the session supports the claim.

If you create a session source, connect non-code session-derived claims with `evidenced_by` edges. Code-verified claims do not need session evidence unless the claim is also recording a session decision, requirement, question, risk, trade-off, or task.

## Quality Bar

- Prefer a small update over broad memory churn.
- Reuse existing components/flows when `greplica graph context` finds them.
- Create new components/flows only when the session introduced or clarified a durable area.
- Use `code_verified` only for claims checked against code.
- Use `source_verified` for claims grounded in the session.
- Use `unknown` for unresolved tasks, questions, and risks.
- Create one `session` source for the current session when storing session-derived claims.
- Add a concise free-text `metadata.reason` to each `evidenced_by` edge.

## Validate And Apply

1. Run `greplica proposal validate <proposal-file>`.
2. Fix validation errors until valid.
3. Run `greplica proposal apply <proposal-file>`.
4. Summarize the durable memory update and mention anything intentionally not stored.
