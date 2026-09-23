-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Input: segment_windows(idx, utid, tid, upid, ts_start, ts_end, sleeping,
-- runnable, waiter_utid); the caller includes android.garbage_collection. A GC
-- is matched by process: it can stall any thread of that process, so it is
-- process-level evidence, weaker than a signal on the segment's own thread.
-- dur_ns is the half-open overlap clipped to the segment; segment_rank orders a
-- segment's rows by it. Collections are prefiltered to the chain's processes and
-- overall window before the per-segment join.
segment_gc_candidates AS MATERIALIZED (
  SELECT *
  FROM android_garbage_collection_events AS gc
  WHERE gc.upid IN (SELECT upid FROM segment_windows WHERE upid IS NOT NULL)
    AND gc.gc_ts < (SELECT MAX(ts_end) FROM segment_windows)
    AND gc.gc_ts + gc.gc_dur > (SELECT MIN(ts_start) FROM segment_windows)
),
segment_gc_events AS (
  SELECT
    segs.idx AS segment_idx,
    gc.gc_type,
    gc.is_mark_compact,
    gc.reclaimed_mb,
    MIN(gc.gc_ts + gc.gc_dur, segs.ts_end) - MAX(gc.gc_ts, segs.ts_start) AS dur_ns,
    gc.gc_dur AS event_dur_ns,
    gc.thread_name,
    gc.process_name,
    ROW_NUMBER() OVER (
      PARTITION BY segs.idx
      ORDER BY MIN(gc.gc_ts + gc.gc_dur, segs.ts_end) - MAX(gc.gc_ts, segs.ts_start) DESC
    ) AS segment_rank
  FROM segment_windows AS segs
  JOIN segment_gc_candidates AS gc
    ON segs.upid IS NOT NULL
   AND gc.upid = segs.upid
   AND gc.gc_ts < segs.ts_end
   AND gc.gc_ts + gc.gc_dur > segs.ts_start
)
