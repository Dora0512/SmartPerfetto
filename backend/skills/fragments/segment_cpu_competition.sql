-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Input: segment_windows(idx, utid, tid, upid, ts_start, ts_end, sleeping,
-- runnable, waiter_utid). Only runnable (R/R+) segments waited for a CPU, so
-- only they are examined.
--
-- segment_cpu_targets: the CPU(s) a runnable segment's thread was queued on or
-- eventually ran on, read from its thread_state rows. This is the one
-- end-inclusive match (`ts.ts <= segs.ts_end`): the row starting exactly at the
-- segment end is the CPU it eventually ran on.
-- segment_cpu_competition: other threads' sched slices on that CPU inside the
-- segment, clipped to it on the half-open interval. sched holds only running
-- slices, so no state filter is needed; utid 0 is the idle task, not a
-- competitor. segment_rank orders a segment's rows by clipped running time.
-- Both scans are prefiltered to the chain's threads or CPUs and its overall
-- window before the per-segment join.
segment_cpu_state_candidates AS MATERIALIZED (
  SELECT ts.utid, ts.ts, ts.dur, ts.cpu
  FROM thread_state AS ts
  WHERE ts.utid IN (SELECT utid FROM segment_windows WHERE runnable = 1)
    AND ts.cpu IS NOT NULL
    AND ts.ts <= (SELECT MAX(ts_end) FROM segment_windows WHERE runnable = 1)
    AND ts.ts + ts.dur > (SELECT MIN(ts_start) FROM segment_windows WHERE runnable = 1)
),
segment_cpu_targets AS MATERIALIZED (
  SELECT
    segs.idx AS segment_idx,
    segs.utid,
    c.cpu,
    segs.ts_start,
    segs.ts_end
  FROM segment_windows AS segs
  JOIN segment_cpu_state_candidates AS c
    ON c.utid = segs.utid
   AND c.ts <= segs.ts_end
   AND c.ts + c.dur > segs.ts_start
  WHERE segs.runnable = 1
  GROUP BY segs.idx, c.cpu
),
segment_sched_candidates AS MATERIALIZED (
  SELECT s.ts, s.dur, s.cpu, s.utid
  FROM sched AS s
  WHERE s.cpu IN (SELECT DISTINCT cpu FROM segment_cpu_targets)
    AND s.utid != 0
    AND s.ts < (SELECT MAX(ts_end) FROM segment_cpu_targets)
    AND s.ts + s.dur > (SELECT MIN(ts_start) FROM segment_cpu_targets)
),
segment_cpu_competition AS (
  SELECT
    tc.segment_idx,
    tc.cpu,
    s.utid AS competing_utid,
    thr.tid AS competing_tid,
    thr.name AS competing_thread,
    proc.name AS competing_process,
    'Running' AS competing_state,
    MIN(s.ts + s.dur, tc.ts_end) - MAX(s.ts, tc.ts_start) AS competing_dur_ns,
    s.dur AS event_dur_ns,
    ROW_NUMBER() OVER (
      PARTITION BY tc.segment_idx
      ORDER BY MIN(s.ts + s.dur, tc.ts_end) - MAX(s.ts, tc.ts_start) DESC, s.utid
    ) AS segment_rank
  FROM segment_cpu_targets AS tc
  JOIN segment_sched_candidates AS s
    ON s.cpu = tc.cpu
   AND s.ts < tc.ts_end
   AND s.ts + s.dur > tc.ts_start
   AND s.utid != tc.utid
  LEFT JOIN thread AS thr ON thr.utid = s.utid
  LEFT JOIN process AS proc ON proc.upid = thr.upid
)
