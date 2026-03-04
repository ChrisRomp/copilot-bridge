#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "Pulling latest..."
git pull --ff-only

echo "Installing dependencies..."
npm install --silent

echo "Restarting service..."
launchctl unload ~/Library/LaunchAgents/com.copilot-bridge.plist 2>/dev/null || true
sleep 1
launchctl load ~/Library/LaunchAgents/com.copilot-bridge.plist

sleep 3
if launchctl list | grep -q copilot-bridge; then
    echo "✅ copilot-bridge restarted successfully"
    tail -3 /tmp/copilot-bridge.log
else
    echo "❌ Failed to start"
    tail -10 /tmp/copilot-bridge.log
fi
