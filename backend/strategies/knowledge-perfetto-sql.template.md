<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## Perfetto SQL discovery and units

Trace ts/dur filters use nanoseconds. When schema/module discovery is needed,
use lookup_sql_schema/list_stdlib_modules and inspect actual columns; v58+
__intrinsic_stdlib_objects is a discovery catalog, not a Skill artifact table.
Read candidate summary/schema before querying. Exact matching uses =, wildcard
matching uses GLOB; regexp(pattern, input, 'i') is for intentional case-insensitive
partial matching, not a blanket replacement.
