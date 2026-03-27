#!/usr/bin/env bash
# Click-to-run launcher for EO///DB
# Double-click this file in your file manager to start the server.

set -e

# Change to the script's directory so paths resolve correctly
cd "$(dirname "$(readlink -f "$0")")"

# Pull latest version from GitHub
echo "Fetching latest version from GitHub..."
git fetch origin main
git checkout main
git reset --hard origin/main
echo "Updated to latest version."

# Install/update dependencies
echo "Installing dependencies..."
npm install

echo ""
echo "Starting EO///DB server..."
echo "Open http://localhost:3000 in your browser."
echo "Press Ctrl+C to stop."
echo ""

npx tsx src/server.ts
