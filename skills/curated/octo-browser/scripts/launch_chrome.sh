#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

browser_path="${1:-}"
if [[ -z "${browser_path}" ]]; then
  browser_path="$("${script_dir}/resolve_browser.sh")"
fi

user_data_dir="${2:-${OCTO_BROWSER_USER_DATA_DIR:-$HOME/.octo/chrome_dir}}"
cdp_port="${3:-${OCTO_BROWSER_CDP_PORT:-9999}}"
extra_args="${OCTO_BROWSER_EXTRA_CHROME_ARGS:-}"

mkdir -p "${user_data_dir}"

declare -a command_args
command_args=(
  "${browser_path}"
  "--user-data-dir=${user_data_dir}"
  "--remote-debugging-port=${cdp_port}"
)

if [[ -n "${extra_args}" ]]; then
  read -r -a extra_args_array <<<"${extra_args}"
  command_args+=("${extra_args_array[@]}")
fi

command_args+=("about:blank")

"${command_args[@]}" >/dev/null 2>&1 &
printf '%s\n' "$!"
