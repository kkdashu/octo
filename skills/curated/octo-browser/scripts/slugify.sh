#!/usr/bin/env bash

set -euo pipefail

input="${*:-}"

if [[ -z "${input}" ]]; then
  echo "slugify.sh requires input text" >&2
  exit 1
fi

slug="$(printf '%s' "${input}" | tr '[:upper:]' '[:lower:]')"
slug="$(printf '%s' "${slug}" | sed -E 's#https?://##g; s#[^a-z0-9._-]+#-#g; s#-+#-#g; s#(^[-.]+|[-.]+$)##g')"

if [[ -z "${slug}" ]]; then
  slug="page"
fi

printf '%s\n' "${slug}"
