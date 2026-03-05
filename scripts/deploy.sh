#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "Pulling latest..."
git pull --ff-only

echo "Installing dependencies..."
npm install --silent

echo "Restarting service..."
"$(dirname "$0")/restart-gateway.sh"
