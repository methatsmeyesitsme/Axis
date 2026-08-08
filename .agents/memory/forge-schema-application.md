---
name: Forge schema application
description: Durable guidance for keeping Forge's database-backed app storage tables available.
---

Forge's file, table, data, and generated-app account tables are part of the shared Drizzle schema and must exist in the development database before Forge can build apps. The post-merge setup must target the actual `@workspace/db` package; a generic `db` filter can silently skip the schema push.

**Why:** Forge generation failed because `forge_app_files` was present in the schema source but absent from development PostgreSQL, so every file write failed and the model stopped mid-build.

**How to apply:** Keep the schema in `lib/db/src/schema/forge.ts`, verify all Forge tables after development setup, and use the package's checked-in Drizzle config via `pnpm --filter @workspace/db run push`. Do not add startup-time DDL or production migration logic.