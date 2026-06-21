#!/usr/bin/env bash
# Serve DualSense Doctor on localhost (a secure context, required by WebHID).
set -e
PORT="${1:-8777}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
URL="http://localhost:$PORT/studio.html"
echo "DualSense Studio → $URL   (diagnostic at /index.html)"
echo "Open it in Chrome or Edge (WebHID is not in Safari/Firefox)."
# Open Chrome at the URL if available, then serve.
if command -v open >/dev/null 2>&1; then
  ( sleep 1; open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL" ) &
fi
exec python3 -m http.server "$PORT"
