#!/usr/bin/env bash
# Create a brand-new private GitHub repository and push Helix to it.
# Refuses to push into an already-existing repository.
#
# Usage:
#   GITHUB_TOKEN=... ./scripts/publish.sh [owner] [new-repo-name]
# Defaults: owner from `gh api user -q .login`, repo=helix-harness
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]]; then
  echo "Set GITHUB_TOKEN (repo create + push scope) first." >&2
  exit 1
fi
export GH_TOKEN="${GITHUB_TOKEN:-$GH_TOKEN}"

OWNER="${1:-$(gh api user -q .login)}"
REPO="${2:-helix-harness}"
FULL="$OWNER/$REPO"

if gh repo view "$FULL" >/dev/null 2>&1; then
  echo "Refusing to reuse existing repository: $FULL" >&2
  echo "Choose a new repo name that does not already exist." >&2
  exit 1
fi

gh repo create "$FULL" \
  --private \
  --description "Recursive self-improving agent harness with an immutable event kernel" \
  --source=. \
  --remote=origin \
  --push

echo "Created private repository: https://github.com/$FULL"
