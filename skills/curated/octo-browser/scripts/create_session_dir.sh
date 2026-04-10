#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

label="${*:-page}"
storage_root="$("${script_dir}/resolve_storage_root.sh")"
date_dir="$(date +%F)"
time_prefix="$(date +%H%M%S)"
slug="$("${script_dir}/slugify.sh" "${label}")"
session_dir="${storage_root}/${date_dir}/${time_prefix}-${slug}"

mkdir -p "${session_dir}/screenshots"
printf '%s\n' "${session_dir}"
