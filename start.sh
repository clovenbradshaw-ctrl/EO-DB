#!/usr/bin/env bash
# Click-to-run launcher for EO///DB
# Double-click this file in your file manager to start the server.

set -e

# Change to the script's directory so paths resolve correctly
cd "$(dirname "$(readlink -f "$0")")"

# Install dependencies if node_modules is missing
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting EO///DB server..."
echo "Open http://localhost:3000 in your browser."
echo "Press Ctrl+C to stop."
echo ""

npx tsx src/server.ts
