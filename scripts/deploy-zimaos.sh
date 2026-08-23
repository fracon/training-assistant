#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Pulling latest training-assistant image..."
docker compose pull

echo "Restarting container..."
docker compose up -d

echo "Deployment finished. Training Assistant: http://localhost:8080"
