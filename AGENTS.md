# SmartPerfetto Agent Guide

This is the canonical project-scoped guide for AI coding agents. Maintain
shared rules here and durable area-specific contracts in `.claude/rules/`
and product docs. `CLAUDE.md` imports this file as a compatibility entrypoint;
other agent adapters should point here without duplicating the rules.

## Communication

- Default to Simplified Chinese for user-facing communication; keep code,
  commands, and technical identifiers in English. Honor an explicit language request.
- Lead with the outcome and impact, then explain actions, unresolved decisions,
  and evidence where useful. Use concise, connected paragraphs; use lists only
  for parallel items, comparisons, or steps.
- Use concrete words. Avoid filler, jargon without a purpose, repeated
  summaries, and unrequested contrasts. Include technical details when they
  help the user understand the result, judge risk, or reproduce it.
- Disagree with a suggestion when evidence shows it would undermine the goal;
  explain why and recommend a workable alternative.

## Authority and Context

- Follow system, platform, and safety constraints. The user's current explicit
  instructions take precedence over project defaults, Skills, memory, and
  personal preferences. This guide applies only within this repository;
  more specific directory rules refine the relevant scope.
- Before editing, inspect the live worktree, this guide, relevant rules, source,
  and existing tests. Scripts, configuration, probes, and current runtime
  evidence establish project facts; documentation records intended contracts.
  Resolve discrepancies explicitly rather than treating old reports as live proof.
- When the task depends on prior decisions or results, search available
  memory/history. Stop when enough relevant context is found; consult local
  summaries or rollouts only to resolve a remaining historical question. Reuse
  prior work after checking current truth; clarify whether to extend or re-review only
  when the current request leaves that choice unresolved.
- Read Skills and detailed rules relevant to the task. If a rule or Skill causes
  a pause, cite the exact file and instruction and explain the unresolved need;
  distinguish an explicit requirement from your interpretation. Do not use the
  `brainstorming` Skill.

## Execution

- For an implementation request, continue through the authorized work,
  verification, and necessary fixes until the intended result is complete or
  a concrete blocker requires user input. A plan or passing test alone is not
  completion. Keep explanation, review, and diagnosis requests read-only unless
  the user also asks for a change.
- Make routine, reversible decisions within the agreed scope. Before asking
  for approval, finish independent authorized work that makes the decision
  concrete and reviewable. Do not repeatedly request existing authorization
  or add approval steps for hypothetical risks; actual scope and permission
  boundaries still apply.
- Ask one focused question only when an unresolved decision materially affects
  the goal, scope, acceptance criteria, or an irreversible action. Establish
  facts yourself and decide routine reversible details within the authorized
  scope. Use the full `grilling` flow only when explicitly requested. Existing
  authorization does not need another final confirmation.
- For non-trivial changes, state the touched files, change order, dependencies,
  and risks; apply the independent review gate below, then Execute -> Verify ->
  Revise. Review architecture and affected contracts, not just the local diff.
- Use the smallest applicable verification tier in `.claude/rules/testing.md`.
  Report what changed, what was actually verified, and any material gap;
  distinguish local edits from commits, pushes, and releases.
- Remove only this task's disposable temporary artifacts. Preserve user data,
  unrelated changes, and evidence needed for review or release.

## Tools and Delegation

- Prefer `rg` and `rg --files` for text and file search; use GitNexus for symbol
  relationships and impact as required by `.claude/rules/git.md`. Refresh its
  index with `--index-only` so analysis does not rewrite agent entrypoints.
- Batch independent reads and queries. Keep shared state, dependent decisions,
  and conflicting operations serial. Prefer an available CLI/API; use the
  user's authenticated browser when the task requires a web console.
- Delegate only a bounded, independent workstream or an independent review
  that saves time or improves quality. State inputs, ownership, outputs, and
  completion criteria. Keep simple tasks and shared decisions with the primary
  agent, which inspects and validates the combined result. Follow
  `.claude/rules/agent-orchestration.md` when delegating.

## Basics

- SmartPerfetto is an AGPL-licensed, AI-assisted Android Perfetto analysis
  platform: pre-built Perfetto UI, Express backend, AI runtimes, YAML Skills,
  Markdown strategies, and a `trace_processor_shell` pool.
- Core stack: Node.js 24 LTS, TypeScript strict mode, Express, forked Perfetto
  UI submodule, committed `frontend/` prebuild for user and Docker paths.
- Default user path is `./start.sh`. Use `./scripts/start-dev.sh` only for
  Perfetto UI plugin development.

## Common Commands

```bash
./start.sh
./scripts/start-dev.sh
./scripts/start-dev.sh --quick
./scripts/update-frontend.sh
./scripts/restart-backend.sh
cd backend && npm run build
```

## Must-Follow Rules

- Preserve unrelated local changes; inspect git status before editing.
- Do not hardcode prompt content in TypeScript. Use `backend/strategies/` and
  `backend/skills/`.
- Do not hardcode MCP tool lists, Skill counts, scene lists, or AI output
  sections in adapter docs or TypeScript. Use the registry/frontmatter files
  and the reference docs as the source of truth.
- Do not manually edit generated files; fix the generator/template and
  regenerate.
- Keep tracked documentation limited to current user, architecture, runtime,
  and maintainer contracts. Do not commit dated plans, review reports,
  research dumps, presentation sources, or agent evidence; fold durable
  conclusions into a core document and use issues, PRs, or git history for
  implementation history.
- Preserve the AI output contract: final conclusions, evidence/claim
  verification, identity resolution, reports, snapshots, CLI output, and
  frontend chat projection are separate surfaces. Keep chat readable without
  deleting report/snapshot provenance.
- Before widening a detector, check real inputs at token-budget, whitespace,
  and placeholder/comment boundaries. Supply missing context where possible.
- Determine authorship from required run state: what was dispatched, collected,
  and streamed. Provider-error wording can also be ordinary trace-analysis
  content; it cannot establish who wrote an answer.
- Narrate both tool calls and results through the shared narration layer.
  Describe the outcome, or emit nothing when it cannot be stated honestly;
  serialized payloads and row/column/evidence counts are not user-facing findings.
- Extract structured facts before transport truncation, including `planPhaseId`
  and `success` before `summarizeExternalToolResult`. Preserve plan attribution
  and success evidence even when the transported result is shortened.
- Each user-facing line should add information beyond the preceding line.
- `frontend/` is consumed by Docker, `./start.sh`, and portable packages. After
  AI Assistant plugin UI changes, verify in dev mode and run
  `./scripts/update-frontend.sh`.
- Keep Provider Manager/runtime provider pinning semantics intact.
- Do not push a root commit that points at a local-only `perfetto/` submodule
  commit.
- Before committing or pushing changes to Skills, Strategies, portable SQL,
  evidence/identity contracts, trace-processor pins, or the public exporter,
  run `npm run check:perfetto-skills-impact` with the arguments defined in
  `.claude/rules/skills.md` and record `required`, `not_required`, or `deferred` with the required
  reason/handoff and change fingerprint.
- Before feature or bug work, check the affected product surfaces in
  `.claude/rules/product-surface.md`.
- Treat startup/readiness, loopback URLs, portable paths or package layout,
  bundled runtimes/native modules, signing, and notarization changes as
  portable-impacting work; follow the PR and release gates in
  `.claude/rules/testing.md` and `.claude/rules/release.md`.
- Use GitNexus impact analysis and pre-commit change detection for the changes
  defined in `.claude/rules/git.md`; cross-check graph results against source
  and tests.
- Before syncing, rebasing, merging, or upgrading official Perfetto code,
  trace processor prebuilts, SQL docs, stdlib indexes, or committed Perfetto UI
  prebuilds, read `.claude/rules/perfetto-sync.md`.
- Before publish, package, tag, npm, Docker, or portable release work, read
  `.claude/rules/release.md` plus `.claude/rules/git.md` and
  `.claude/rules/testing.md`.

## Independent Review Gate

Use Plan -> independent read-only review -> Revise -> Execute for changes with
material architecture, security, release, shared-state, or public-contract risk.
File count alone does not trigger this gate. For other non-trivial work, state
a concise plan and review the resulting diff; delegate only when useful.

- If the primary agent is not Codex and a Codex review tool is available, prefer
  Codex read-only review.
- If the primary agent is Codex, do not call Codex to review itself. Prefer a
  read-only reviewer sub-agent/tool.
- Use review tools actually available in the current environment; do not assume
  a particular model, plugin, machine path, or tool schema.
- If no stable reviewer is available, use structured self-review plus post-diff
  review, note the fallback, and rely on
  the relevant verification tier from `.claude/rules/testing.md`.
- Retry a reviewer only when evidence suggests a transient failure; do not
  wait for repeated timeouts solely to qualify for the fallback.
- Reviewers must not edit files.
- When delegation or parallel work can help a non-trivial task, read
  `.claude/rules/agent-orchestration.md`; it extends this gate without
  replacing Plan -> independent review -> Revise -> Execute.

## Detailed Rules

Read the relevant detailed rule before touching that area:

- `.claude/rules/backend.md`
- `.claude/rules/frontend.md`
- `.claude/rules/prompts.md`
- `.claude/rules/skills.md`
- `.claude/rules/codebase-aware.md`
- `.claude/rules/agent-orchestration.md`
- `.claude/rules/product-surface.md`
- `.claude/rules/perfetto-sync.md`
- `.claude/rules/release.md`
- `.claude/rules/testing.md`
- `.claude/rules/git.md`

Run the smallest verification tier that proves the change. Before opening or
landing a PR, run `npm run verify:pr` from the repository root.

## GitNexus navigation

Use `.claude/rules/git.md` for impact-analysis scope, safe index refresh,
pre-commit checks, and unavailable-tool fallback. Keep that policy in one place;
do not restore generic generated `Always Do` / `Never Do` boilerplate here.
Index maintenance uses `--index-only` to preserve this authored guide.

For a relevant dependency question, use `impact` or `context`; use `query` for
an unfamiliar execution flow and `rg` for exact text or paths. Read only the
resources needed to resolve the question. Tool output is evidence to cross-check,
not a substitute for source or proof of a regression.

| Task | Skill |
| --- | --- |
| Understand execution flows | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Assess dependencies | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace a bug across modules | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename or restructure shared code | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tool schemas and resources | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index maintenance | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |
