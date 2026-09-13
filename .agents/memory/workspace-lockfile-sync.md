---
name: Workspace lockfile sync
description: The workspace lockfile must reflect the pnpm override map before frozen installs are used.
---

The workspace's pnpm override configuration is part of the lockfile contract. If overrides change without a lockfile refresh, `pnpm install --frozen-lockfile` fails before restoring workspace links.

**Why:** A stale lockfile prevented the API and Axis packages from getting their local dependency links, which looked like unrelated missing-package and missing-Vite failures.

**How to apply:** After changing workspace dependency overrides, refresh the lockfile with a non-frozen install, then use frozen installs again for validation.