#!/usr/bin/env bash
# Double-click this file to launch EO///DB and open the admin UI.

set -euo pipefail

REPO_URL="https://github.com/clovenbradshaw-ctrl/eo-db.git"
REPO_DIR="$HOME/eo-db"

# Clone if first run, otherwise pull latest
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "First run — cloning EO///DB..."
  git clone "$REPO_URL" "$REPO_DIR"
else
  echo "Fetching latest version from GitHub..."
  cd "$REPO_DIR"
  git fetch origin main
  git checkout main
  git reset --hard "origin/main"
fi

cd "$REPO_DIR"

echo ""
echo "=== EO///DB Version ==="
echo "  Commit:  $(git rev-parse --short HEAD)"
echo "  Date:    $(git log -1 --format='%ci')"
echo "  Message: $(git log -1 --format='%s')"
echo "========================"
echo ""

# Install/update dependencies
echo "Installing dependencies..."
npm install

# Start the server in the background
echo "Starting EO///DB server..."
npx tsx src/server.ts &
SERVER_PID=$!

# Wait for the server to be ready
echo "Waiting for server to start..."
for i in $(seq 1 30); do
  if curl -s http://localhost:3000/health > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Open the admin UI in the default browser
ADMIN_FILE="$REPO_DIR/eo-db-admin.html"
echo "Opening admin UI in browser..."
open "$ADMIN_FILE"

echo ""
echo "EO///DB is running at http://localhost:3000"
echo "Press Ctrl+C to stop."
echo ""

# Wait for the server process (keeps the terminal open)
wait $SERVER_PID
