#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Pulling the Kinesis server image..."
docker compose pull training-assistant

echo "Building the private Garmin connector for this host architecture..."
docker compose build garmin-connector

echo "Restarting container..."
docker compose up -d

echo "Deployment finished. Training Assistant: http://localhost:8081"
