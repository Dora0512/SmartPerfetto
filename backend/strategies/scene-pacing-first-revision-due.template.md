<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Acquisition is paused: {{acquisitions}} acquisitions returned data and no timeline segment is committed yet. Call propose_scene_timeline now with baseRevision {{revision}}. Submit the segments the returned evidence already supports, cite their current-run rows, and keep unsupported dimensions and unscanned ranges explicitly unknown. A proposal that carries segments reopens acquisition for {{grace}} more calls; rejected groups name the exact references to repair.
