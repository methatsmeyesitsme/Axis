---
name: API dependency links
description: Environment-specific recovery guidance for missing workspace package links.
---

When the API bundle reports that a package cannot be resolved even though the package is declared in the service manifest, run the workspace package install/link step before changing route code. In this workspace, a stale or missing pnpm link can make every API route appear broken at once.

**Why:** The API service failed at startup because its `@google/genai` workspace link was missing; route-level debugging would have hidden the shared startup failure.

**How to apply:** Confirm the package manifest and lockfile first, run the workspace install with the existing lockfile, rebuild shared TypeScript declarations if exports appear stale, then restart the managed API workflow and test health plus a real streaming endpoint.