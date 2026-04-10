#!/usr/bin/env bash

set -euo pipefail

host="${1:-${OCTO_BROWSER_CDP_HOST:-127.0.0.1}}"
port="${2:-${OCTO_BROWSER_CDP_PORT:-9999}}"

curl -sf "http://${host}:${port}/json/version" >/dev/null
