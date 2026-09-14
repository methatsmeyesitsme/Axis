#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Apply the application's managed schema using its checked-in Drizzle config.
# The explicit workspace package name is required in this monorepo; the old
# `--filter db` silently matched nothing, leaving newly added Forge tables out
# of the development database.
#
# Uses `push-force` (drizzle-kit push --force), NOT plain `push`: plain push
# prompts interactively (arrow-key confirmation) whenever it needs to create
# a new table or column. In this automated hook there's no one to answer
# that prompt, so it silently hangs until the hook's timeout kills it —
# leaving the migration unapplied with no visible error. This is exactly
# what happened to the `github_connections` table: the schema was correct
# and committed, but the table was never actually created in the live DB.
pnpm --filter @workspace/db run push-force
