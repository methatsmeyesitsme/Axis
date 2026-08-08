#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Apply the application's managed schema using its checked-in Drizzle config.
# The explicit workspace package name is required in this monorepo; the old
# `--filter db` silently matched nothing, leaving newly added Forge tables out
# of the development database.
pnpm --filter @workspace/db run push
