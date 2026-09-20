# Source facts

- v1.11.0 verifies conclusion claims against retained execution captures.
- It performs one bounded, no-tool semantic review of the complete answer.
- The candidate conclusion body is preserved even when checks fail.
- Claim results include verified, partial, unchecked, and failed states.
- Web, CLI, HTML reports, snapshots, JSON/NDJSON, and CLI turn artifacts receive the delivery result.
- v1.12.0 exposes closed-vocabulary failure causes, transport status, and attempt counts.
- Provider retry applies only to transient connection, 408/425/429, and 5xx failures.
