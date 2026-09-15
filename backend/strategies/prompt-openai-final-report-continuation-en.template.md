<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

The native candidate needs completion with reason code: {{completion_reason}}. output_limit means the model output cap; empty_body means no narrative remains outside machine protocol segments; invalid_protocol means malformed declaration framing or fields; turn_limit means investigation turns are exhausted and this summary uses the turn reserved inside the total budget. This is the only completion attempt in the same analysis run, and tools are disabled.

For turn_limit, first state that the investigation is incomplete, summarize evidence-supported findings and unfinished questions, and say when the evidence cannot establish a root cause. Plan or hypothesis status is not a verified finding.

Use only evidence already returned in the complete conversation to produce one complete, self-contained answer from beginning to end, replacing the incomplete candidate. Do not merely append its missing tail, repeat tool calls, or claim unfinished analysis phases are complete.

Protocol repair is not an abridgment: preserve every distinct finding supported by returned evidence, its affected interval, adjacent readable evidence, source mechanism and necessary limits. Deduplicate wording without collapsing valid findings into a single dominant cause or aggregate table. The draft itself is not evidence; explicitly correct unsupported judgments or retain them as unverified. An unfinished investigation still explains the known findings and their individual gaps.

If the original candidate contains conclusion declarations, retain them and correct their protocol format; never delete declarations to bypass validation. Keep the visible answer outside machine protocol blocks.

The resolved user intent for this run is:
{{turn_intent}}

Respect that intent's scope and deliverable: answer bounded questions directly with the requested facts and implementation relationship; use report structure only when the intent or scene contract requires a report. Continue following the original scene, evidence, source-reference, and conclusion-declaration contracts. Prioritize required conclusions, exact references, declarations, and limitations; omit optional preambles and repeated process narration.

Preserve source/evidence identifiers and bindings actually returned by tools. Do not invent identifiers or measurements, or treat a source mechanism as proof that it occurred in this trace. Mark unsupported portions as unknown or unverified. The incomplete candidate is not evidence; do not rewrite causal propositions or remove necessary evidence boundaries to complete the answer.

The parser observed these structural diagnostics for the original candidate. Field locations, expected types and reason codes are fixed protocol facts; counts describe declared entries, not valid claims. Correct the reported format without changing the claim meaning or inventing evidence. Missing required collections must still use the canonical schema; do not remove claims to clear an error.

{{candidate_protocol_diagnostic}}
