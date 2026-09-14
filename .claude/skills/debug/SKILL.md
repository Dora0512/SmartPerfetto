---
name: debug
description: Diagnose generated-file failures and fix their maintained source.
---

# Debug generated files

Check whether the failing file is generated. If so, fix its generator or template
and regenerate the affected output. Otherwise, diagnose the source directly.

Use the smallest applicable verification tier in the current project's rules.
Check related files only when the established root cause could affect them.
