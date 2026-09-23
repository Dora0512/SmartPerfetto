-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Input: segment_windows(idx, utid, tid, upid, ts_start, ts_end, sleeping,
-- runnable, waiter_utid), one row per critical-path segment; the caller includes
-- android.binder. Attaches a transaction when either side ran on the segment's
-- thread and overlaps it on the half-open interval (an event that ends exactly
-- where the segment starts belongs to the previous segment). dur_ns is the
-- overlap clipped to the segment, event_dur_ns the whole side's slice. The
-- client wins when both sides match, because a sync client slice encloses its
-- server slice. segment_rank orders each segment's rows by clipped time so a
-- consumer can keep the top rows per segment. Transactions are prefiltered to
-- the chain's threads and overall window before the per-segment join.
segment_binder_candidates AS MATERIALIZED (
  SELECT *
  FROM android_binder_txns AS txn
  WHERE (txn.client_utid IN (SELECT utid FROM segment_windows)
      OR txn.server_utid IN (SELECT utid FROM segment_windows))
    AND (
      (txn.client_ts < (SELECT MAX(ts_end) FROM segment_windows)
        AND txn.client_ts + COALESCE(txn.client_dur, 0) > (SELECT MIN(ts_start) FROM segment_windows))
      OR (txn.server_ts < (SELECT MAX(ts_end) FROM segment_windows)
        AND txn.server_ts + COALESCE(txn.server_dur, 0) > (SELECT MIN(ts_start) FROM segment_windows))
    )
),
segment_binder_hits AS (
  SELECT
    segs.idx AS segment_idx,
    segs.ts_start,
    segs.ts_end,
    txn.binder_txn_id,
    txn.binder_reply_id,
    txn.interface,
    txn.method_name,
    txn.is_sync,
    txn.is_main_thread,
    txn.client_process,
    txn.client_thread,
    txn.server_process,
    txn.server_thread,
    txn.client_utid,
    txn.server_utid,
    txn.client_tid,
    txn.server_tid,
    txn.client_ts,
    COALESCE(txn.client_dur, 0) AS client_dur,
    txn.server_ts,
    COALESCE(txn.server_dur, 0) AS server_dur,
    COALESCE(
      txn.client_utid = segs.utid
        AND txn.client_ts < segs.ts_end
        AND txn.client_ts + COALESCE(txn.client_dur, 0) > segs.ts_start,
      0
    ) AS client_hit,
    COALESCE(
      txn.server_utid = segs.utid
        AND txn.server_ts < segs.ts_end
        AND txn.server_ts + COALESCE(txn.server_dur, 0) > segs.ts_start,
      0
    ) AS server_hit
  FROM segment_windows AS segs
  JOIN segment_binder_candidates AS txn
    ON txn.client_utid = segs.utid OR txn.server_utid = segs.utid
),
segment_binder_events AS (
  SELECT
    *,
    CASE WHEN client_hit THEN client_ts ELSE server_ts END AS ev_ts,
    CASE WHEN client_hit THEN client_dur ELSE server_dur END AS ev_dur
  FROM segment_binder_hits
  WHERE client_hit OR server_hit
),
segment_binder_txns AS (
  SELECT
    segment_idx,
    binder_txn_id,
    binder_reply_id,
    CASE
      WHEN client_hit AND server_hit THEN 'both'
      WHEN client_hit THEN 'client'
      ELSE 'server'
    END AS side,
    interface,
    method_name,
    is_sync,
    is_main_thread,
    client_process,
    client_thread,
    server_process,
    server_thread,
    client_utid,
    server_utid,
    client_tid,
    server_tid,
    MIN(ev_ts + ev_dur, ts_end) - MAX(ev_ts, ts_start) AS dur_ns,
    ev_dur AS event_dur_ns,
    ROW_NUMBER() OVER (
      PARTITION BY segment_idx
      ORDER BY MIN(ev_ts + ev_dur, ts_end) - MAX(ev_ts, ts_start) DESC, binder_txn_id
    ) AS segment_rank
  FROM segment_binder_events
)
