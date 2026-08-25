#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ ! -d node_modules ]]; then
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install
  else
    corepack enable >/dev/null 2>&1 || true
    pnpm install
  fi
fi

exec pnpm exec tsx packages/cli/src/main.ts "$@"
