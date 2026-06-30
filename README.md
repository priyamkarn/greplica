<div align="center">

<img alt="Greplica" src="docs/assets/greplica-arcade-font2.png" width="420">

### Persistent, searchable engineering memory for AI coding agents

<p>
  <a href="https://www.npmjs.com/package/greplica"><img alt="npm package" src="https://img.shields.io/npm/v/greplica?color=111111"></a>
  <img alt="Agents" src="https://img.shields.io/badge/agents-Codex%20%7C%20Claude%20Code-2563eb">
  <img alt="Storage" src="https://img.shields.io/badge/storage-local%20SQLite-475569">
  <img alt="Embeddings" src="https://img.shields.io/badge/embeddings-local%20%7C%20OpenAI-16a34a">
  <a href="https://discord.gg/q2R6AYXh9"><img alt="Discord" src="https://img.shields.io/badge/discord-join-5865F2"></a>
</p>

</div>

---

Does your coding agent spend 5 minutes just grepping around when you give it a complex task?

That's because it is re-learning context. Every new session, your agent wastes tokens and time building context on work it already did. And still misses important facts.

**Greplica** explores your repo structure, code and session transcripts (fully local, no telemetry) to give your agent a persistent, maintained memory it can query before exploring.

---

## Agent Quick Start

Most users should not install Greplica by hand. Paste this into your coding agent from inside the repo you want Greplica to remember.

Greplica requires Node.js 22-26.

```txt
Install Greplica for this repo using https://raw.githubusercontent.com/Autoloops/greplica/refs/heads/main/docs/agent-install-prompt.md.
```

Full prompt: [docs/agent-install-prompt.md](https://raw.githubusercontent.com/Autoloops/greplica/refs/heads/main/docs/agent-install-prompt.md)

That prompt asks a short setup questionnaire, installs Greplica with your chosen hook mode, creates the first saved context from the repo, and can optionally pull durable learnings from recent sessions.

To visualise your current memory in browser, run:

```bash
greplica graph view
```

---

## How It Works

Greplica starts by reading your repo shallowly and pulling out the parts a future agent would otherwise have to rediscover: which area owns what, how important workflows cross files, why certain code is shaped the way it is, which constraints keep showing up, and where to look first. During setup, `greplica-bootstrap` does that first pass by reading high-signal docs, config, entrypoints, and type boundaries instead of trying to memorize the whole codebase.

What it saves is plain and practical: important parts of the codebase, recurring workflows, decisions, constraints, gotchas, follow-up work, and file anchors that point the agent at the right place. Under the hood, those are stored as `components`, `flows`, and `claims`, plus sources and links between them, in a local SQLite database at `~/.greplica/graph.db` unless `GREPLICA_HOME` overrides it. Greplica validates each proposal before applying it, writes it as a new memory commit, and chains that commit to the previous one in the same repo scope.

That first pass is only the start. If you have useful old sessions, `greplica-fast-session-bootstrap` can read a bundled transcript and save the parts that should survive beyond chat history: durable decisions, gotchas, rejected approaches, and follow-up work. After normal work sessions, hooks can remind the agent to query Greplica early and, if you enabled auto-save, try a background update after enough activity. If hooks are unavailable or you want to do it manually, `greplica-update-working-memory` saves the durable learnings from the current session without turning the whole transcript into clutter.

When the next agent starts a task, it asks Greplica a focused question with `greplica graph context "<question>"`. Greplica compares that question against what it has already saved, combines embeddings, keyword scoring, and relationship boosts, and returns the most relevant decisions, workflows, and code locations as Markdown the agent can act on immediately. The agent still reads code, but it starts from the right files and with the right constraints in mind instead of grepping from scratch.

A result can look like this:

```markdown
# Graph Context

## Components

- `component.knowledge_graph_service` Knowledge Graph Service
  Anchor: `libs/knowledge-graph/service.ts`
- `component.sqlite_repository` SQLite Repository
  Anchor: `libs/storage/sqlite/repository.ts`

## Flows

### Proposal Apply

ID: `flow.proposal_apply`

Claims:
- `claim.apply_validates_before_writing` (fact, code_verified): applyProposal validates the proposal before writing any records.
- `claim.memory_commits_chain_with_parent` (fact, code_verified): Each memory commit stores a reference to its predecessor.

## Other Relevant Claims

- `claim.apply_prints_commit_scope_and_counts` (fact, code_verified): proposal apply prints the memory commit ID, scope ID, and created object counts.
```

That is the loop Greplica is trying to tighten: read the repo once, keep the useful parts, bring them back when an agent asks, then keep refining them as work continues.

---

## SWE-chat Benchmarks

We also benchmark Greplica on held-out planning tasks built from [SWE-chat](https://www.swe-chat.com/), a dataset of real coding-agent sessions from public repositories ([dataset](https://huggingface.co/datasets/SALT-NLP/SWE-chat), [paper](https://arxiv.org/abs/2604.20779)).

For each case, we start from a clean base snapshot of the repo, use 2-4 earlier sessions from that same repo to build Greplica context, and then run the same held-out planning task in two modes: a baseline run with no Greplica context, and a Greplica run where the agent can query `greplica graph context` during the task. Greplica context is created with one bootstrap pass plus replayed session updates, so the agent starts from the kind of saved repo-specific decisions and workflow knowledge that real teams build up over time.

Across the showcased planning cases, Greplica often cuts token usage by roughly 40-50% and can reduce wall-clock time by around 30%. It can also improve the result itself: in the stronger cases, the agent produces a better plan because it starts with the right repo-specific constraints, decisions, and subsystem boundaries instead of rediscovering them late. In the strongest run we measured, Greplica used 75.0% fewer tokens and finished about 38% faster.

Current showcase examples:

- `swechat-gemini-voyager-sync-auth-bug` hardened rerun: score `100 -> 100`, `75.0%` fewer tokens, `140.4s` faster.
- `swechat-iptvnator-playback-layout-plan`: score `64 -> 100`, `44.6%` fewer tokens.
- `swechat-marin-harbor-swe-eval-support`: score `6 -> 100`, `26.7%` fewer tokens, `80.2s` faster.

---

## Commands

```bash
greplica install --platform codex|claude|copilot|opencode|openhands|factory-droid --embedding local|openai [--hooks enabled|disabled] [--auto-memory enabled|disabled]
greplica config
greplica doctor [--check-embeddings]
greplica graph read
greplica graph context "<query>" [--debug]
greplica graph audit anchors
greplica graph view [--out <file>] [--no-open]
greplica graph export <dir>
greplica transcript bundle --platform codex|claude|copilot --file <path> [--file <path>...] --out <bundle.md>
greplica proposal validate <proposal.json>
greplica proposal apply <proposal.json>
```

- `greplica graph context "<query>"` - returns Markdown for agent use. Add `--debug` for the full retrieval payload with ranking signals.
- `greplica graph read` - prints the current graph view: all components, flows, claims, sources, and edges in scope.
- `greplica graph view` to visualise the current memory in a local HTML, opens in your default browser. Use `--out` to choose where the file is written; by default it goes to a temp path.
- `greplica transcript bundle` - converts one or more Codex, Claude Code, or GitHub Copilot CLI JSONL transcripts into a sanitized Markdown bundle for `greplica-fast-session-bootstrap`.
- `greplica doctor` - verifies installation and diagnoses configuration failures. Not a required preflight before every command.
- `greplica install` prepares repo state, local storage, and agent integration; normal repo commands require install first.

For **OpenHands**, install is repo-local: skills are written to `.agents/skills/` and the `UserPromptSubmit`/`Stop` hooks to `.openhands/hooks.json` (Claude/Codex/Copilot install to the agent's home config instead). GitHub Copilot CLI installs personal skills under `~/.copilot/skills` (or `$COPILOT_HOME/skills`) and user hooks under `~/.copilot/hooks/greplica.json`. The hooks inject `graph context` guidance and trigger background working-memory updates; OpenHands must trust the repo hooks for the background save to run.
