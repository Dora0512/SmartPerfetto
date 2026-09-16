# Git and Submodule Rules

## Repository Remotes

Root repository:

- `origin`: `git@github.com:Gracker/SmartPerfetto.git`

Perfetto submodule:

- Path: `perfetto/`
- This is a fork of Google's official Perfetto repository.
- `origin` inside the submodule is upstream Google Perfetto.
- `fork` inside the submodule is Gracker's fork.

Never push SmartPerfetto submodule changes to upstream `origin`.

## Root Workflow

1. Inspect `git status --short --branch` before editing.
2. Preserve unrelated local changes; assume they belong to the user.
3. Run the verification tier that matches the change.
4. Stage only the files that belong to the requested change.
5. Commit with a descriptive message.
6. Push the active branch when the task asks for push/ship.

## GitNexus Impact Analysis

Treat GitNexus as an architecture and change-impact radar, not as the source of
truth. Use the `gitnexus-impact-analysis` Skill for changes to shared behavior,
dependencies, module boundaries, schemas, or public contracts, and when a
non-trivial bug's impact is uncertain. This includes relevant runtime, provider,
session, report, Skill/Strategy, and AI Assistant UI changes. Docs, comments,
and small local edits that preserve behavior and dependencies do not need a
graph query or refresh merely because a symbol is touched.

During planning:

1. Check `gitnexus status` when graph analysis is needed. If its relevant
   coverage is missing or stale, run
   `gitnexus analyze --index-only --default-branch main`. Do not run
   `gitnexus setup` or allow analysis to rewrite agent files or install Skills.
2. Run upstream impact analysis for the key changed symbol with depth 3, tests
   included, and confidence 0.8 or higher. Review direct dependants first, then affected
   processes and modules.
3. Cross-check the graph with `rg`, the relevant source, existing tests, and the
   product surfaces in `.claude/rules/product-surface.md`.

Before committing a change in this scope, stage only the task-owned files and
run GitNexus change detection with `scope: staged`. Use `scope: all` only when the whole dirty worktree is
intentionally in scope. Review affected processes and high-risk symbols, then
run the verification tier from `.claude/rules/testing.md`. A direct dependency
is a compatibility question, not proof that the caller breaks. Report HIGH or
CRITICAL graph results and verify the relevant behavior before editing.

If GitNexus is unavailable, cannot index the affected surface, or still fails
after a justified refresh, inspect direct references, source, and affected tests
instead. Report the gap and residual uncertainty; do not turn this task into an
index repair or installation project. Unresolved material impact still requires
investigation or a focused question before the dependent change.

Prefer the GitNexus MCP `impact` and `detect_changes` tools. If MCP is not
available, use:

```bash
gitnexus impact <symbol> --direction upstream --depth 3 --include-tests
gitnexus detect-changes --scope staged
```

The local generated index lives under `.gitnexus/` and must remain untracked.
`.gitnexusignore` is the tracked coverage contract: it excludes generated
frontend output, Trace corpus data, and the upstream Perfetto tree while
retaining `perfetto/ui/src/` and conventional test directories. If a change is
outside that graph boundary, verify it directly and update the coverage contract
only when the omitted surface should be maintained by SmartPerfetto.

## Portable Release Workflow

Read `.claude/rules/release.md` before any public release. This section keeps
the git-specific portable rules only.

Portable releases are published from the root repository, not from the
`perfetto/` submodule. The default release uploads Windows x64, macOS arm64,
and Linux x64 assets to the same GitHub Release.

Normal public release flow:

1. Start from an up-to-date clean `main`.
2. Run `npm run version:set -- <version>`.
3. Run `npm run version:sync -- --check`.
4. Commit `package.json`, `package-lock.json`, `backend/package.json`, and
   `backend/package-lock.json`.
5. Push `main`.
6. Publish and smoke the npm CLI when the version is public.
7. Run `npm run package:portable`.
8. Run `npm run release:portable -- <version> --skip-build --no-draft
   --smoke-evidence-dir <evidence-dir>` with exact-archive target-native evidence.

Release invariants:

- Asset names and top-level directories must be versioned:
  `smartperfetto-v<version>-windows-x64.zip`,
  `smartperfetto-v<version>-macos-arm64.zip`, and
  `smartperfetto-v<version>-linux-x64.tar.gz`.
- Do not publish the old unversioned `smartperfetto-windows-x64.zip` asset
  name.
- Do not use `--allow-dirty` for public releases. It is only acceptable for
  draft/test uploads where a dirty package is intentional.
- `--skip-build` is safe only when the existing zip was freshly built for the
  exact version and commit being released.
- The release script must verify the package manifest, commit, dirty state,
  remote release target, and uploaded asset before reporting success.
- The npm CLI package must publish from `backend/` as
  `@gracker/smartperfetto` and expose both `smp` and `smartperfetto`.
- `dist/portable/` and `dist/windows-exe/` are generated output; never stage or
  commit them.

## Submodule Landing Order

When a task changes `perfetto/`:

1. Enter `perfetto/`.
2. Commit the submodule change.
3. Push that commit to the submodule `fork` remote.
4. Return to the root repository.
5. If the change affects the AI Assistant plugin UI or generated Perfetto UI
   output, run `./scripts/update-frontend.sh` and stage the resulting
   `frontend/` changes.
6. Stage the root gitlink (`perfetto`) plus required root artifacts.
7. Commit and push the root repository only after the submodule commit is
   reachable from `fork/main`, not merely from some `fork` branch.

Do not push a root commit that points to a local-only submodule commit. Docker
Hub and user installs consume the root `frontend/` prebuild and the root
gitlink; both must point to committed, pushed artifacts.

## Submodule Gitlink Anchoring

A pushed submodule commit is not safe merely because some `fork` branch
contains it. A gitlink reachable only from a feature branch becomes an
unreachable commit the moment that branch is deleted, and a fresh
`git clone --recursive` then fails for every root commit that points at it.
Every gitlink the root repository publishes must be reachable from `fork/main`.

Run this before pushing a root gitlink, and again before deleting any submodule
branch:

```bash
git -C perfetto fetch --prune fork
GITLINK=$(git ls-tree HEAD perfetto | awk '{print $3}')
git -C perfetto merge-base --is-ancestor "$GITLINK" fork/main
```

A non-zero exit means the gitlink is not anchored. Fast-forward the submodule
branch and push it before continuing:

```bash
git -C perfetto checkout main
git -C perfetto merge --ff-only "$GITLINK"
git -C perfetto push fork main
```

If that fast-forward is not clean, the submodule branch has genuinely diverged.
Resolve the divergence; never force-push `fork/main` to make the check pass.

Branch deletion has to clear the tags too, because each release tag pins its own
gitlink and the current `main` says nothing about older ones:

```bash
for t in $(git tag); do
  gl=$(git ls-tree "$t" perfetto 2>/dev/null | awk '{print $3}')
  [ -n "$gl" ] || continue
  git -C perfetto merge-base --is-ancestor "$gl" fork/main 2>/dev/null \
    || echo "ORPHAN: $t -> $gl"
done
```

Every `ORPHAN` line names a published release whose submodule commit would stop
being reachable. Anchor it before deleting the branch that currently holds it.

`ls-remote fork HEAD` and `branch --contains HEAD` do not prove anchoring: both
are satisfied by any feature branch. On 2026-09-16 the root `main` gitlink was
reachable only from `codex/source-activation-latency-20260901`, with the
submodule's own `main` 15 commits behind it, so the weaker checks reported it as
reachable while a routine branch cleanup would have orphaned the v1.11.0
gitlink. Fast-forwarding `main` re-anchored all 58 release tags at once.

## Generated and Ignored Files

Expected ignored local state includes:

- `.claude/settings.local.json`
- `.claude/worktrees/`
- `backend/logs/`
- `logs/`
- `backend/test-output/`
- `perfetto/out/`
- `node_modules/`

Do not add ignored runtime data unless the task explicitly changes ignore
policy.
