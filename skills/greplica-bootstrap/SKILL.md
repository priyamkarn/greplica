---
name: greplica-bootstrap
description: Bootstrap Greplica memory for the current repository. Use only when the user explicitly invokes greplica-bootstrap or asks to create initial engineering memory for a repo with the greplica CLI.
disable-model-invocation: true
---

# Bootstrap Greplica Memory

Create shallow, high-signal Greplica memory for the current repository.

## Preconditions

Run from the target repository root or any subdirectory inside it.

1. Run `greplica doctor`.
2. If `greplica` is missing, tell the user to run the Greplica setup prompt from the README.
3. If `OPENAI_API_KEY` is missing, stop. Do not ask the user to paste the key into chat. Tell them to set it in their shell before launching the coding agent, or in repo-root `.env.local`.

`greplica` automatically prepares repo memory state; do not ask the user to run a separate initialization command.

## Inspect The Repo Shallowly

Read enough to orient a future coding agent:

- README and docs if present.
- package/config/build files.
- top-level tree.
- app/lib entrypoints.
- schema/type/model files that define durable concepts.
- bundled skill files such as `skills/*/SKILL.md`, when present.
- tests only when they clarify important behavior.
- existing memory with `greplica graph read`.

Do not perform a deep audit. Prefer major subsystems and human workflows over file-by-file or function-level memory.

When the repo has separate files for related responsibilities, keep them separate if that helps navigation. In particular:

- Do not collapse proposal normalization and proposal validation when they live in different files.
- Do not collapse persistent repository operations and database schema/open/migration code when they live in different files.
- Represent graph schema/type/model files as their own component when they define the memory model.
- Represent bundled agent skills as a component when the repo ships skills that guide important workflows.
- Add a dedicated flow for compact relationship fields becoming canonical graph edges when the repo supports compact proposal syntax.

## Proposal Format

Write a JSON proposal to a temporary file:

```json
{
  "title": "Bootstrap repo memory",
  "summary": "Top-level engineering memory for this repository.",
  "creates": {
    "components": [
      {
        "id": "component.example",
        "name": "Example component",
        "code_anchor": "src/example.ts"
      }
    ],
    "flows": [
      {
        "id": "flow.example",
        "name": "Example workflow",
        "touches": ["component.example"]
      }
    ],
    "claims": [
      {
        "id": "claim.example",
        "kind": "fact",
        "text": "Example component participates in Example workflow.",
        "truth": "code_verified",
        "intent": "unknown",
        "about": ["component.example", "flow.example"]
      }
    ],
    "sources": [],
    "edges": []
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

Sources currently represent session artifacts. Do not create a source just because code was inspected during bootstrap.

## Quality Bar

- Prefer roughly 4-10 major components for a small repo.
- Include major flows that help future agents decide where to look.
- Include claims that capture why the main modules matter, not just which commands exist.
- Capture boundary facts such as thin CLI wrappers, service boundaries, git-based repo detection, global source storage, and shallow bootstrap guidance when the inspected code or skill files support them.
- Use `code_verified` only for claims grounded in inspected code.
- Use `unknown` truth for unverified questions, risks, or tasks.
- Add open questions/tasks for important areas that need deeper inspection.
- Avoid noisy structure nodes, tiny helpers, private functions, and one claim per file.

## Validate And Apply

1. Run `greplica proposal validate <proposal-file>`.
2. Fix validation errors until valid.
3. Run `greplica proposal apply <proposal-file>`.
4. Summarize what memory was created and mention the proposal file path if it still exists.
