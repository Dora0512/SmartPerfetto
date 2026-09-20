Edit Image 1 into a factually correct 16:9 whiteboard architecture diagram while preserving the clean hand-drawn style, five runtime boxes, mode router, and terminal-state branch.

Required corrections:
- Put small unboxed title "五运行时共享连续分析协议" at top-left; remove the large boxed title.
- The shared layer below the five runtimes must be labeled exactly "请求意图 · 调查要求 · 证据上下文". Do not label this shared layer as an artifact.
- `smp probe` is an independent pre-batch gate. Draw a separate small lane: "同一份 artifact" → "smp probe" → "OK N 或带来源错误" → batch start. Do not insert `smp probe` into a user's per-run request or into the five-runtime shared contract.
- Continuity lane must read: "执行" → "检查点" → "恢复" → "预留一次无工具交付".
- Draw one solid bracket labeled "硬上限" that contains the entire continuity lane. Place "有进展时有界延长" inside that hard-cap bracket. Do not draw any extension beyond the hard cap.
- Terminal states: "complete", "partial", "timeout", "Provider 失败", "用户停止".

Constraints: opaque pure white background; Simplified Chinese; orthogonal arrows; outline-only boxes; no implication of unlimited retries or time beyond the hard cap; no layout clutter.
