#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "  EO///DB — Starting server..."
echo ""
npm install --silent 2>/dev/null
echo "  Server running at http://localhost:3000"
echo "  Opening admin UI..."
echo ""
echo "  Press Ctrl+C to stop."
echo ""
open eo-db-admin.html
npx tsx src/server.ts
