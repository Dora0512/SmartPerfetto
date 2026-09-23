-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Inputs: wake_source_scope(utid) chooses the sleeping threads; thread_roles
-- comes from fragments/thread_role.sql; ${start_ts}/${end_ts} bound the scan.
--
-- Why the successor row is read instead of the sleep row: Perfetto records
-- waker_utid and irq_context on the first R/R+ row AFTER a sleep, never on the
-- S/D row itself, so each wait is re-linked to the row that starts at its end
-- timestamp. One wake can be split into R then R+, so MAX collapses a wait to
-- one row.
--
-- Why this exists at all: on Android, sched_blocked_reason is emitted only for
-- TASK_UNINTERRUPTIBLE (android14-6.1 try_to_wake_up, android16-6.12
-- __schedule), so thread_state.blocked_function is NULL on every S row. Socket
-- receive and epoll waits are S. The wake source is the only kernel-side
-- signal left for them.
--
-- D/DK rows are carried too, so a blocking-chain consumer can attribute
-- uninterruptible waits with the same vocabulary; blocked_function stays the
-- D-only kernel signal and is not replaced by anything here.
--
-- A binder waker is recognised by thread_roles.role, not by a second name
-- pattern here: Android 12+ uses lowercase `binder:<pid>_<n>`, and a duplicated
-- `Binder:*` test would silently drop almost every binder wake back into
-- worker_handoff. The binder test runs before the same-process test because an
-- in-process binder pool thread delivering a transaction is a binder wake, not
-- an application hand-off.
--
-- wait_class is a CANDIDATE label, never a root cause. An irq-context wake is
-- equally a NET_RX softirq, a timer expiry (Object.wait(timeout), Thread.sleep,
-- epoll timeout) and a device interrupt; only combining it with the sleeping
-- thread's role narrows it, and only an rx packet correlation confirms it.
wake_source_waits AS (
  SELECT s.id AS state_id, s.utid, s.ts, s.dur, s.state,
    s.blocked_function, s.io_wait,
    MAX(n.waker_utid) AS waker_utid,
    MAX(n.irq_context) AS irq_context
  FROM thread_state s
  JOIN wake_source_scope sc ON sc.utid = s.utid
  LEFT JOIN thread_state n
    ON n.utid = s.utid
    AND n.ts = s.ts + s.dur
    AND n.state IN ('R', 'R+')
    AND n.waker_utid IS NOT NULL
  WHERE s.state IN ('S', 'I', 'D', 'DK')
    AND s.dur > 0
    AND s.ts < ${end_ts}
    AND s.ts + s.dur > ${start_ts}
  GROUP BY s.id
),
wake_source_facts AS (
  SELECT w.state_id, w.utid, sr.tid, sr.thread_name, sr.role AS thread_role,
    sr.upid, sr.process_name, w.ts, w.dur, w.ts + w.dur AS wake_ts, w.state,
    w.blocked_function, w.io_wait,
    w.waker_utid, wr.tid AS waker_tid, wr.thread_name AS waker_thread_name,
    wr.upid AS waker_upid, wr.process_name AS waker_process_name,
    COALESCE(wr.role, 'unknown') AS waker_role,
    COALESCE(w.irq_context, 0) AS irq_context,
    wr.tid = 0 OR wr.thread_name GLOB 'swapper*' AS waker_is_idle,
    wr.role = 'binder' AS waker_is_binder,
    wr.upid IS NOT NULL AND wr.upid = sr.upid AS waker_in_same_process,
    wr.process_name = 'system_server'
      OR wr.process_name GLOB '*surfaceflinger'
      OR wr.process_name GLOB '*netd'
      OR wr.process_name GLOB 'vendor.*'
      OR wr.process_name GLOB 'android.hardware.*'
      OR wr.process_name GLOB '/vendor/bin/*' AS waker_is_system
  FROM wake_source_waits w
  JOIN thread_roles sr ON sr.utid = w.utid
  LEFT JOIN thread_roles wr ON wr.utid = w.waker_utid
),
-- The two labels are derived from ONE set of facts on purpose: a second copy of
-- the binder / same-process / system-process tests could drift and then report a
-- wake_source and a wait_class that contradict each other on the same row.
sleep_wake_source AS (
  SELECT f.state_id, f.utid, f.tid, f.thread_name, f.thread_role,
    f.upid, f.process_name, f.ts, f.dur, f.wake_ts, f.state,
    f.blocked_function, f.io_wait,
    f.waker_utid, f.waker_tid, f.waker_thread_name,
    f.waker_upid, f.waker_process_name, f.waker_role, f.irq_context,
    CASE
      WHEN f.irq_context = 1 THEN 'irq_or_softirq'
      WHEN f.waker_utid IS NULL THEN 'unknown'
      WHEN f.waker_is_idle THEN 'swapper'
      WHEN f.waker_is_binder THEN 'binder_thread'
      WHEN f.waker_in_same_process THEN 'same_process_thread'
      WHEN f.waker_is_system THEN 'system_process'
      ELSE 'unknown'
    END AS wake_source,
    CASE
      WHEN f.irq_context = 1 AND f.thread_role = 'network'
        AND f.state IN ('S', 'I') THEN 'network_receive_candidate'
      WHEN f.irq_context = 1 THEN 'timer_or_device_wake'
      WHEN f.waker_utid IS NULL THEN 'unknown'
      WHEN f.waker_is_binder THEN 'binder_reply'
      WHEN f.waker_in_same_process THEN 'worker_handoff'
      WHEN f.waker_is_system THEN 'system_service'
      ELSE 'unknown'
    END AS wait_class
  FROM wake_source_facts f
)
