#!/usr/bin/env bash
# Everything CI runs. Exit 0 when the tree is releasable by these checks,
# and 1 as soon as any check fails.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

./tests/run

validator=""
if [[ -n ${OMARCHY_TEST_ROOT:-} && -x ${OMARCHY_TEST_ROOT}/bin/omarchy ]]; then
  validator="${OMARCHY_TEST_ROOT}/bin/omarchy"
elif command -v omarchy >/dev/null 2>&1; then
  validator="omarchy"
fi

if [[ -n $validator ]]; then
  archive="$(mktemp -d)"
  trap 'rm -rf "$archive"' EXIT
  # Agent skills are export-ignore, so the archive check does not lint vendored skills.
  git archive HEAD | tar -xf - -C "$archive"
  "$validator" plugin validate "$archive"
fi

printf 'verify: all checks passed.\n'
