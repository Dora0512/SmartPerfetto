-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Inputs: segment_windows(idx, utid, tid, upid, ts_start, ts_end, sleeping,
-- runnable, waiter_utid) and io_blocked_function_families from
-- fragments/io_blocked_function_families.sql. There is no stdlib I/O table, so
-- I/O attribution reads the segment thread's own D/DK thread_state rows: the
-- io_wait flag, or a blocked_function in an I/O family. Candidates are
-- prefiltered to the chain's threads and overall window before the
-- per-segment join (a per-segment scan of thread_state is the costly shape).
-- dur_ns is the half-open overlap clipped to the segment; segment_rank orders a
-- segment's rows by it.
segment_io_candidates AS MATERIALIZED (
  SELECT ts.utid, ts.ts, ts.dur, ts.blocked_function, ts.io_wait
  FROM thread_state AS ts
  WHERE ts.utid IN (SELECT utid FROM segment_windows)
    AND ts.state IN ('D', 'DK')
    AND ts.ts < (SELECT MAX(ts_end) FROM segment_windows)
    AND ts.ts + ts.dur > (SELECT MIN(ts_start) FROM segment_windows)
    AND (
      ts.io_wait = 1
      OR EXISTS (
        SELECT 1 FROM io_blocked_function_families AS f
        WHERE LOWER(COALESCE(ts.blocked_function, '')) GLOB f.pattern
      )
    )
),
segment_io_rows AS (
  SELECT
    segs.idx AS segment_idx,
    c.blocked_function,
    c.io_wait,
    MIN(c.ts + c.dur, segs.ts_end) - MAX(c.ts, segs.ts_start) AS dur_ns,
    c.dur AS event_dur_ns
  FROM segment_windows AS segs
  JOIN segment_io_candidates AS c
    ON c.utid = segs.utid
   AND c.ts < segs.ts_end
   AND c.ts + c.dur > segs.ts_start
),
segment_io_signals AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY segment_idx ORDER BY dur_ns DESC) AS segment_rank
  FROM segment_io_rows
)
