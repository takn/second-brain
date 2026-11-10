#!/usr/bin/env bash
# One-command local development: stack up, migrate, run web + worker.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

echo "Starting local stack (postgres, minio, elasticmq)..."
docker compose up -d --wait

set -a
# shellcheck disable=SC1091
source .env
set +a

# The local stack signs with the static creds from .env. A globally exported
# AWS_PROFILE would make the AWS SDK ignore them (its default chain skips env
# credentials when AWS_PROFILE is set), mysteriously failing MinIO auth.
unset AWS_PROFILE AWS_SESSION_TOKEN

echo "Applying database migrations..."
pnpm --filter @second-brain/schema migrate

echo "Starting web (http://localhost:${PORT:-3000}) and worker..."
exec pnpm exec concurrently --kill-others -n web,worker -c blue,magenta \
  "pnpm --filter web dev" \
  "pnpm --filter worker dev"
