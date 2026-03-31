#!/usr/bin/env bash
# check-coupling.sh — CI smoke test asserting zero openclaw/wintermute/obsidian
# coupling in Ripline's core src/ files.
#
# Exits 0 only when all checks pass.
# Usage: bash scripts/check-coupling.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/src"

PASS=0
FAIL=0

check() {
  local label="$1"
  local pattern="$2"
  local exclude_pattern="$3"

  if grep -ri "$pattern" "$SRC" --include="*.ts" | grep -v "$exclude_pattern" > /dev/null 2>&1; then
    echo "FAIL: $label"
    grep -ri "$pattern" "$SRC" --include="*.ts" | grep -v "$exclude_pattern" || true
    FAIL=$((FAIL + 1))
  else
    echo "PASS: $label"
    PASS=$((PASS + 1))
  fi
}

echo "=== Ripline coupling checks ==="
echo ""

# wintermute: zero hits outside integrations/openclaw/
check \
  "wintermute refs outside integrations/openclaw/" \
  "wintermute" \
  "src/integrations/openclaw/"

# obsidian: zero hits outside integrations/openclaw/
check \
  "obsidian refs outside integrations/openclaw/" \
  "obsidian" \
  "src/integrations/openclaw/"

# openclaw: zero hits outside integrations/ and conditional loader (src/index.ts)
check \
  "openclaw refs outside integrations/ and src/index.ts" \
  "openclaw" \
  "src/integrations/\|src/index\.ts"

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo "ERROR: Coupling checks failed — see above for details." >&2
  exit 1
fi

echo "All coupling checks passed."
exit 0
