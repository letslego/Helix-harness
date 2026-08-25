#!/usr/bin/env bash
# Publish Helix to a new GitHub repository.
# Usage:
#   GITHUB_TOKEN=... ./scripts/publish.sh [owner] [repo]
# Defaults: owner from `gh api user -q .login`, repo=helix
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]]; then
  echo "Set GITHUB_TOKEN (repo create + push scope) first." >&2
  exit 1
fi
export GH_TOKEN="${GITHUB_TOKEN:-$GH_TOKEN}"

OWNER="${1:-$(gh api user -q .login)}"
REPO="${2:-helix}"
FULL="$OWNER/$REPO"

if gh repo view "$FULL" >/dev/null 2>&1; then
  echo "Repository $FULL already exists."
else
  gh repo create "$FULL" --public --source=. --remote=origin --description "Recursive self-improving agent harness with an immutable event kernel"
fi

git push -u origin HEAD:main
echo "Published: https://github.com/$FULL"
