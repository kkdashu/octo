#!/usr/bin/env bash

set -euo pipefail

chrome_path=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
do
  if [ -x "$candidate" ]; then
    chrome_path="$candidate"
    break
  fi
done

if [ -z "$chrome_path" ]; then
  echo "Google Chrome executable not found" >&2
  exit 1
fi

printf '%s\n' "$chrome_path"

if curl -sf http://127.0.0.1:9222/json/version >/dev/null; then
  exit 0
fi

echo "No CDP-enabled Chrome is reachable on 127.0.0.1:9222" >&2
echo "Start your existing Chrome with --remote-debugging-port=9222, then rerun this script." >&2
exit 1
