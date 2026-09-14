---
name: gitnexus-impact-analysis
description: Check dependency and execution-flow impact for shared behavior, interface changes, or an explicit impact-analysis request.
---

# Impact analysis with GitNexus

Follow the current project's scope and verification rules. Use graph analysis
for shared behavior, dependency, interface, or module-boundary changes, or an
uncertain cross-module bug. Docs, comments, and small local edits preserving
behavior and dependencies do not need graph analysis merely because a symbol
is touched.

Use `impact` on the key changed symbol to find upstream dependencies. Review
direct callers first and read relevant source to determine compatibility:

```text
impact({target: "symbolName", direction: "upstream", minConfidence: 0.8, maxDepth: 3})
```

A direct dependency is not proof of breakage. Judge risk by the actual behavior
and contracts changed, not a fixed symbol count. Report HIGH or CRITICAL graph
results and cross-check them before the dependent edit; do not dismiss a risk
that remains unexplained.

Read a specific affected process or use `context` only when its call chain
resolves a remaining question. Do not load every process by default. Before
committing changes in this scope, inspect task-owned staged changes:

```text
detect_changes({scope: "staged"})
```

Preserve unrelated dirty changes. Reuse relevant graph results when the source
and index have not changed. Refresh an index only when its missing or stale
coverage matters, using the project's runner with `analyze --index-only` so
maintained agent instructions are preserved. Do not run setup as a prerequisite.
If the graph is unavailable or remains unreliable after a justified refresh,
use direct references, source and affected tests; report uncertainty and resolve
material impact before proceeding. Stop once the task's impact is understood.
