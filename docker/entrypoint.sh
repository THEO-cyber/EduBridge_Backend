#!/bin/sh
set -e

echo "[entrypoint] Syncing Prisma schema..."
npx prisma db push --skip-generate --accept-data-loss
echo "[entrypoint] Schema sync complete."

echo "[entrypoint] Starting application..."
exec "$@"
