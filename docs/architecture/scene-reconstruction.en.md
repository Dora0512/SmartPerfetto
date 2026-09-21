# Scene Reconstruction Architecture Contract

[English](scene-reconstruction.en.md) | [中文](scene-reconstruction.md)

Scene reconstruction investigates user actions, device state and application response within a requested Trace range, producing a chronological, traceable structured timeline. For the user workflow, see [Basic Usage](../getting-started/usage.en.md#scene-reconstruction). This document defines acquisition, candidate revisions, assessment, presentation and historical access boundaries.

## Entry and Execution Ownership

Clicking Scene Reconstruction starts a full investigation through `POST /api/agent/v1/scene-reconstruct` with the current Provider. The route obtains its objective from a localized Strategy template and selects `scene_reconstruction` on the server. Neither an HTTP body nor model output can grant itself this internal entry identity.

The entry shares `analysisRunDispatchService` with ordinary `/analyze`: session preparation, permissions and the AI switch, tenant and Trace authorization, quota, admission, Provider pinning, run, lease and manifest follow the same lifecycle. The selected runtime uses the normal Agent tool loop and can investigate ambiguities. This is not a fixed SQL pass followed by a model-written summary.

```text
User click + current Provider
  → shared analysis admission and run
  → trusted scene context + pinned Strategy
  → Agent queries input / device / application-response facts
  → propose_scene_timeline candidate revisions and diagnostics
  → shared finalizeAnalysisResult
  → UI, report and history projections of the same revision
```

The scene capability is bound to the current owner, Trace, session and run. Run context and publication tokens are issued only in process and cannot be restored from JSON. After runtime return, the product finalizes once and emits one terminal outcome. Late events from stopped, failed or stale runs cannot change the final revision.

Auto mode's scene inventory remains a preview for choosing a deep-dive scope. Its contract differs from the full scene investigation; preview output cannot become this run's assessed timeline simply by being reused.

## Facts and Candidate Revisions

The investigation obtains facts through registered Skills such as `scene_reconstruction` and `scene_device_state_changes`, then follows available sources and schemas into input, windows, lifecycle, device state and rendering response. Methodology lives in `backend/strategies/scene-reconstruction.strategy.md`; SQL and producer metadata live in `backend/skills/`. TypeScript owns lifecycle, types and evidence boundaries.

Each segment retains a stable ID, exact decimal nanosecond `startNs` / `endNs`, object identity and three separate descriptions:

| Field | Question |
| --- | --- |
| `userAction` | What did the user do, and how far does input evidence support it? |
| `deviceState` | What state was the device in, and which changes were observable? |
| `appResponse` | How did the application or system respond, and which object owns that response? |

An unsupported dimension remains unknown without erasing observations in other dimensions. Missing input, frames or state samples do not mean idle. Multiple MOVE events alone do not prove scrolling; an absent inertial-scroll source cannot justify inventing a fling. OEM DeviceState values retain their raw identifiers unless device-specific configuration supports a posture mapping.

A first observation of charging or another state does not establish a transition at that instant. `ACTION_SCROLL` remains scroll-axis input; its action code alone cannot establish a physical wheel. `scene_response_markers` retains raw Scroll / FlingStart markers with process identity, timestamps and marker execution intervals. A duration parameter in a marker name does not establish the observed end of the action.

`propose_scene_timeline` submits candidate deltas with a `baseRevision`, adding, revising or removing segments. References must resolve to artifacts / evidence and original row positions captured by actual tools in this run. Proposal responses, model notes and historical reports are not fresh evidence. Acceptance means a revision was stored; the model cannot declare it verified. Revision conflicts, missing references and object or boundary contradictions should trigger further investigation.

Long traces require windowed investigation with state and open boundaries carried across windows. Reading every artifact page cannot recover rows already discarded by a SQL LIMIT. Producer truncation, parsing failures and unqueried ranges remain separate limitations. Resource limits produce explicit partial results, never a silently truncated tail presented as complete.

## Assessment and Coverage Boundaries

Finite checks answer only mechanically testable predicates, such as whether a reference belongs to this run, an object identity matches or a time boundary is supported. Each check is `passed`, `contradicted` or `unknown`. Even if all pass, the free-form story remains `semanticStatus: unverified`; these checks cannot establish action semantics or causal attribution.

Scan coverage and capture completeness describe different facts:

- **Scan coverage** uses the required sources in `scene-coverage-policy.yaml` as a fixed denominator, bound to the Skill and fragment definitions actually used by this run. Server-issued execution receipts determine scanned and unscanned windows for each source and producer fingerprint. Missing producers and unexecuted sources remain in the denominator.
- **Capture completeness** asks whether the Trace recorded the required events. Currently `captureStatus` remains `unknown`. Table presence, successful queries and zero returned rows cannot establish complete capture.
- **Query coverage status** becomes `complete` only when every required source has a matching producer, successful execution and full coverage of the requested range; otherwise it remains `unknown` or `partial`. A successful rescan can fill an earlier failed window while preserving historical issues separately. Query completion establishes neither capture completeness nor story correctness.

`SceneTimelineAssessment.status` currently remains `partial`, separately from execution reaching a terminal state. A successful investigation does not mean every action was accurately reconstructed. Partial results, failures and cancellation cannot become accurate completion through report generation or historical restoration. The finalizer assesses an existing frozen snapshot; it does not acquire more data or rewrite the story.

## One Revision, Multiple Presentations

`AnalysisResult.sceneTimeline` is the final structured revision. The timeline, top-level scene display, completion SSE, HTML and historical views derive from it, rather than parsing another story from final Markdown. In-flight revision events present candidates; the terminal result must bind the same run and revision.

Browser and HTML views use `projectSceneTimelineForClient`, retaining the three descriptions, exact times, objects, finite checks, coverage and unresolved questions without canonical evidence rows. The HTML Scene Details (JSON) link uses the existing authorized report endpoint; it is not an anonymous share link. Full evidence stays in the owner-partitioned archive. Other ordinary analysis tables retain their own report projection contracts.

Session snapshots may retain the final result. Comparison `summary_json` stores only the `sceneReport` reference, not another timeline. That reference binds Trace, session, run, revision, expiry and manifest hash. It locates a record; it is neither fresh execution evidence nor a publication token.

## Archive, Authorization and Invalidation

The shared finalizer issues a single-use publication bound to scope, canonical revision and actual summary. `SceneStoryService` consumes it to derive the v3 product report; `SceneEvidenceArchive` atomically publishes the manifest for the report, assessment and evidence shards. A result receives its `sceneReport` reference only after successful archival. Failure retains `scene_archive_unavailable` without inventing an available report.

The archive defaults to 7 days of retention, with expiry controlled by its manifest. Reading `/api/agent/v1/scene-reconstruct/report/:reportId` checks both owner and current Trace access. Checksum failure, expiry, Trace deletion or lost authorization must not fall back to memory or legacy v2 caches. Trace deletion invalidates associated archives. Historical SSE, status and snapshots cannot resurrect the archive or issue live proof.

The summary retains its actual generation language and content. Changing the display language localizes UI labels without replacing the saved narrative with a generic scene-count summary.

## Verification Entry and Evidence Scope

The E2E helper has a dedicated scene product-entry option. Run from `backend/`:

```bash
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --entry scene-reconstruction --mode full --provider-id env \
  --trace ../Trace/real/android-scroll-customer/trace.pftrace \
  --output test-output/e2e-scene-reconstruction-real.json --keep-session
```

This requires actual credentials for the selected runtime and the Trace file. It exercises `/scene-reconstruct`, not an ordinary analysis request standing in for it. Its evidence scope is product routing, runtime execution, revision lifecycle and public report-view checks. Passing does not establish narrative semantics or capture completeness. Action accuracy additionally requires independent Trace interval and object facts.

Mock contract tests cannot replace authenticated E2E for each runtime. Current mock passes for other runtimes do not establish authenticated acceptance; real E2E needs its own recorded result. When Qoder authenticated verification is `NOT AVAILABLE`, retain that status rather than counting it as a pass. See [Agent Runtime](agent-runtime.en.md) for Provider and runtime selection.
