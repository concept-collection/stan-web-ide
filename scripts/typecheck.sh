#!/usr/bin/env bash
# Typecheck the app. Diagnostics inside the minwebide vendor tree (VS Code
# source) are reported as a count only — they stem from TS-version and
# ambient-type differences with VS Code's own build and never affect the
# bundle. Errors in the app's own code fail the check.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="$(cd "$ROOT" && npx tsc --noEmit --pretty false 2>&1)"

VENDOR_COUNT="$(printf '%s\n' "$OUTPUT" | grep -cE '/vendor/vscode/' || true)"
OURS="$(printf '%s\n' "$OUTPUT" | grep -vE '/vendor/vscode/|^ ' | grep -v '^$' || true)"

if [ -n "$VENDOR_COUNT" ] && [ "$VENDOR_COUNT" != "0" ]; then
  echo "note: $VENDOR_COUNT vendor diagnostics suppressed (run 'npx tsc --noEmit' to see them)"
fi
if [ -n "$OURS" ]; then
  printf '%s\n' "$OURS"
  exit 1
fi
echo "typecheck OK"
