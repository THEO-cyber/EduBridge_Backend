#!/bin/sh
set -e

# `prisma migrate deploy` applies committed migrations only (never infers/pushes
# schema changes, never drops data) and is safe to run concurrently from multiple
# replicas — it takes an advisory lock internally. Do NOT change this back to
# `prisma db push --accept-data-loss`: that command can silently drop columns/data
# on every container start/restart in production.
echo "[entrypoint] Applying Prisma migrations..."
npx prisma migrate deploy
echo "[entrypoint] Migrations applied."

echo "[entrypoint] Starting application..."
exec "$@"
