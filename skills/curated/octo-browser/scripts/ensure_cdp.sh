#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

host="${OCTO_BROWSER_CDP_HOST:-127.0.0.1}"
port="${OCTO_BROWSER_CDP_PORT:-9999}"
user_data_dir="${OCTO_BROWSER_USER_DATA_DIR:-$HOME/.octo/chrome_dir}"
attempts="${OCTO_BROWSER_CDP_READY_ATTEMPTS:-30}"
sleep_seconds="${OCTO_BROWSER_CDP_READY_SLEEP:-1}"

if "${script_dir}/check_cdp.sh" "${host}" "${port}"; then
  printf 'CDP ready on %s:%s\n' "${host}" "${port}"
  exit 0
fi

browser_path="$("${script_dir}/resolve_browser.sh")"
pid="$("${script_dir}/launch_chrome.sh" "${browser_path}" "${user_data_dir}" "${port}")"

for ((i = 1; i <= attempts; i++)); do
  if "${script_dir}/check_cdp.sh" "${host}" "${port}"; then
    printf 'CDP ready on %s:%s (pid=%s)\n' "${host}" "${port}" "${pid}"
    exit 0
  fi
  sleep "${sleep_seconds}"
done

echo "CDP is not reachable on ${host}:${port} after launching Chrome" >&2
exit 1
