-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Inputs: segment_windows(idx, utid, tid, upid, ts_start, ts_end, sleeping,
-- runnable, waiter_utid), plus thread_roles (fragments/thread_role.sql); the
-- labels come from fragments/sleep_wake_source_labels.sql, which reads the
-- wake_source_waits defined here.
--
-- Only sleeps overlapping a sleeping segment are read: first prefiltered to
-- the chain's threads and overall window (segment_wait_candidates; the
-- per-segment join alone measured 218 ms against 11 ms with it on a
-- 900-segment chain), then attached on the half-open interval, then re-linked
-- to their wakeup row — the first R/R+ row at ts + dur, where Perfetto records
-- waker_utid and irq_context. Each labelled sleep goes back to its segment by
-- thread_state id; dur_ns is clipped to the segment and segment_rank orders a
-- segment's rows by it.
segment_wait_candidates AS MATERIALIZED (
  SELECT id, utid, ts, dur
  FROM thread_state
  WHERE utid IN (SELECT utid FROM segment_windows WHERE sleeping = 1)
    AND state IN ('S', 'I', 'D', 'DK')
    AND dur > 0
    AND ts < (SELECT MAX(ts_end) FROM segment_windows WHERE sleeping = 1)
    AND ts + dur > (SELECT MIN(ts_start) FROM segment_windows WHERE sleeping = 1)
),
segment_wait_rows AS MATERIALIZED (
  SELECT
    segs.idx AS segment_idx,
    c.id AS state_id,
    MIN(c.ts + c.dur, segs.ts_end) - MAX(c.ts, segs.ts_start) AS dur_ns
  FROM segment_windows AS segs
  JOIN segment_wait_candidates AS c
    ON c.utid = segs.utid
   AND c.ts < segs.ts_end
   AND c.ts + c.dur > segs.ts_start
  WHERE segs.sleeping = 1
),
wake_source_waits AS (
  SELECT s.id AS state_id, s.utid, s.ts, s.dur, s.state,
    s.blocked_function, s.io_wait,
    MAX(n.waker_utid) AS waker_utid,
    MAX(n.irq_context) AS irq_context
  FROM thread_state AS s
  LEFT JOIN thread_state AS n
    ON n.utid = s.utid
   AND n.ts = s.ts + s.dur
   AND n.state IN ('R', 'R+')
   AND n.waker_utid IS NOT NULL
  WHERE s.id IN (SELECT state_id FROM segment_wait_rows)
  GROUP BY s.id
),
-- Materialized once and joined by id: an inlined CTE would be re-evaluated per
-- segment (measured: 10 s instead of tens of ms on a 900-segment chain).
segment_wake_labels AS MATERIALIZED (
  SELECT * FROM sleep_wake_source
),
segment_wake_sources AS (
  SELECT
    r.segment_idx,
    w.state,
    r.dur_ns,
    w.dur AS event_dur_ns,
    w.thread_name,
    w.thread_role,
    w.waker_thread_name,
    w.waker_process_name,
    w.waker_role,
    w.irq_context,
    w.wake_source,
    w.wait_class,
    ROW_NUMBER() OVER (PARTITION BY r.segment_idx ORDER BY r.dur_ns DESC, r.state_id) AS segment_rank
  FROM segment_wait_rows AS r
  JOIN segment_wake_labels AS w ON w.state_id = r.state_id
)
