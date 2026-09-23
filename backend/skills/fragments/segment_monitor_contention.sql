-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Input: segment_windows(idx, utid, tid, upid, ts_start, ts_end, sleeping,
-- runnable, waiter_utid); the caller includes android.monitor_contention.
--
-- A contention attaches to a segment from either side:
--   blocked — the segment's thread is the one waiting for the lock;
--   owner   — the segment's thread holds the lock, and the waiter is exactly the
--             thread whose wait this segment explains (waiter_utid: the task for
--             a top-level segment, the parent segment's thread for a recursion
--             child).
-- The owner side is the one a critical path actually sees: while a thread is
-- blocked on a monitor the path follows the owner, so the blocked side alone
-- almost never overlaps a chain segment. Other threads blocked on the same
-- owner are deliberately not attached — they are not the wait being explained.
-- dur_ns is the half-open overlap clipped to the segment; segment_rank orders a
-- segment's rows by it. Contentions are prefiltered to the chain's threads and
-- overall window before the per-segment join.
segment_monitor_candidates AS MATERIALIZED (
  SELECT *
  FROM android_monitor_contention AS mc
  WHERE (mc.blocked_utid IN (SELECT utid FROM segment_windows)
      OR mc.blocking_utid IN (SELECT utid FROM segment_windows))
    AND mc.ts < (SELECT MAX(ts_end) FROM segment_windows)
    AND mc.ts + mc.dur > (SELECT MIN(ts_start) FROM segment_windows)
),
segment_monitor_contention AS (
  SELECT
    segs.idx AS segment_idx,
    CASE WHEN mc.blocked_utid = segs.utid THEN 'blocked' ELSE 'owner' END AS side,
    mc.id,
    mc.short_blocked_method,
    mc.short_blocking_method,
    mc.blocked_thread_name,
    mc.blocking_thread_name,
    mc.blocked_thread_tid,
    mc.blocking_tid,
    mc.blocked_utid,
    mc.blocking_utid,
    MIN(mc.ts + mc.dur, segs.ts_end) - MAX(mc.ts, segs.ts_start) AS dur_ns,
    mc.dur AS event_dur_ns,
    mc.is_blocked_thread_main,
    ROW_NUMBER() OVER (
      PARTITION BY segs.idx
      ORDER BY MIN(mc.ts + mc.dur, segs.ts_end) - MAX(mc.ts, segs.ts_start) DESC, mc.id
    ) AS segment_rank
  FROM segment_windows AS segs
  JOIN segment_monitor_candidates AS mc
    ON (
      mc.blocked_utid = segs.utid
      OR (mc.blocking_utid = segs.utid AND mc.blocked_utid = segs.waiter_utid)
    )
   AND mc.ts < segs.ts_end
   AND mc.ts + mc.dur > segs.ts_start
)
