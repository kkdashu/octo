#!/usr/bin/env bash

set -euo pipefail

storage_root="${OCTO_BROWSER_STORAGE_ROOT:-$HOME/.octo/browser}"

case "${storage_root}" in
  "~")
    storage_root="${HOME}"
    ;;
  "~/"*)
    storage_root="${HOME}/${storage_root#~/}"
    ;;
esac

printf '%s\n' "${storage_root}"
