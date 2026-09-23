<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

What one thread did over one window: running / runnable / sleeping / uninterruptible split, longest waits with `blocked_function`, who woke each one, and what that waker was itself waiting on.

Use when a window is slow and it is still unknown whether the thread computed, queued for CPU, blocked on I/O, or slept on someone else. Route by the dominant `wake_source_class` (`network_receive_candidate`, `timer_or_device_wake`, `worker_handoff`, `binder_reply`, `system_service`, `unknown`) or `blocked_function` to the matching Skill.

Select by `thread_state_id`, by `utid`, or by `process_name` plus `thread_name` or `main_thread`. Without `thread_state_id`, `start_ts` and `end_ts` are required. An ambiguous selector returns candidates, not an answer.

`wake_source_class` is a candidate label, not a root cause: timer and network wakes share one IRQ-context signal and are separated only by thread role. `available: false` carries `unavailableReason`: `task_state_running` (the selected row was running), `no_waiting_time` (the window has no waiting time), or `no_critical_path_stack` (no chain came back; the trace may lack `sched_waking`).
