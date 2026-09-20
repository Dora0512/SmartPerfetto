# Analysis

1. Goal: show how mode routing, five runtimes, checkpoints, bounded delivery, and artifact probing fit together.
2. Content shape: stacked system layers with two side gates.
3. Main elements: Auto/Fast/Full router, five runtimes, shared investigation state, checkpoint store, resume path, delivery reserve, terminal outcomes, `smp probe` artifact gate.
4. Secondary labels: hard time cap, no-tool closeout, parent lineage, same artifact as the batch.
5. Perfetto-style tracks: use a compact horizontal progress bar for active work, checkpoint, resume, and closeout because the protocol has real phases.
