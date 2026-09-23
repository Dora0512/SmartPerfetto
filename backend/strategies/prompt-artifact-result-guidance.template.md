<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Artifact access: forbidRows={{forbidRows}};
requireSummaryBeforeRows={{requireSummaryBeforeRows}}.
If forbidRows is true, the user forbids raw artifact rows; use row-free metadata
and aggregates. Otherwise fetch detail="summary" first; fetch only the minimum rows/full needed for
missing evidence needed to answer, honoring requireSummaryBeforeRows. Respect
the turn's evidence access and scope. Previews do not limit conclusion coverage:
missing or truncated preview data is not absence. Reuse sufficient evidence,
but do not end analysis or drop findings merely because a preview is small.
