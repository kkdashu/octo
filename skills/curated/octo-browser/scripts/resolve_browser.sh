#!/usr/bin/env bash

set -euo pipefail

if [[ -n "${OCTO_BROWSER_PATH:-}" ]]; then
  if [[ -x "${OCTO_BROWSER_PATH}" ]]; then
    printf '%s\n' "${OCTO_BROWSER_PATH}"
    exit 0
  fi

  echo "Configured browser path is not executable: ${OCTO_BROWSER_PATH}" >&2
  exit 1
fi

declare -a candidates=()

if [[ -n "${OCTO_BROWSER_CANDIDATES:-}" ]]; then
  while IFS= read -r candidate; do
    [[ -n "${candidate}" ]] && candidates+=("${candidate}")
  done < <(printf '%s\n' "${OCTO_BROWSER_CANDIDATES}" | tr ':' '\n')
fi

candidates+=(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
  "$HOME/Applications/Chromium.app/Contents/MacOS/Chromium"
  "/usr/bin/google-chrome"
  "/usr/bin/google-chrome-stable"
  "/usr/bin/chromium"
  "/usr/bin/chromium-browser"
)

for candidate in "${candidates[@]}"; do
  if [[ -x "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
    exit 0
  fi
done

for command_name in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "${command_name}" >/dev/null 2>&1; then
    command -v "${command_name}"
    exit 0
  fi
done

echo "Chrome or Chromium executable not found" >&2
exit 1
