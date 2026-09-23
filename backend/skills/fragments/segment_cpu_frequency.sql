-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Inputs: segment_cpu_targets from fragments/segment_cpu_competition.sql; the
-- caller includes linux.cpu.frequency. The highest frequency each target CPU
-- reached inside the segment, computed once per (segment, CPU) rather than
-- once per competing slice, over counters prefiltered to the target CPUs and
-- the overall window.
segment_freq_candidates AS MATERIALIZED (
  SELECT f.cpu, f.ts, f.dur, f.freq
  FROM cpu_frequency_counters AS f
  WHERE f.cpu IN (SELECT DISTINCT cpu FROM segment_cpu_targets)
    AND f.ts < (SELECT MAX(ts_end) FROM segment_cpu_targets)
    AND f.ts + f.dur > (SELECT MIN(ts_start) FROM segment_cpu_targets)
),
segment_cpu_max_freq AS (
  SELECT
    tc.segment_idx,
    tc.cpu,
    MAX(f.freq) AS cpu_max_freq
  FROM segment_cpu_targets AS tc
  JOIN segment_freq_candidates AS f
    ON f.cpu = tc.cpu
   AND f.ts < tc.ts_end
   AND f.ts + f.dur > tc.ts_start
  GROUP BY tc.segment_idx, tc.cpu
)
