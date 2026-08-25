# Helix self-map

Read this file before making self-maintenance changes.

## Layout

- `packages/kernel` — immutable durable substrate (events, agents, lineage, sandboxes, secrets)
- `packages/runtime` — turn loop, model clients, tool registry
- `packages/agent` — default agent tools, instructions, experiment helpers
- `packages/cli` — `helix` command-line interface
- `prompts/me.md` — identity prompt injected every turn
- `.helix/` — local durable state (gitignored)

## Safe self-improvement loop

1. `open_experiment` with a hypothesis
2. Edit agent/runtime code (not kernel) or prompts
3. Validate with `shell` (`pnpm test`, focused checks)
4. `close_experiment` as `promoted` or `abandoned`
5. Optionally `clone_agent` to preserve a lineage branch

## Immutable by policy

- `packages/kernel/**`
- `LICENSE`
- `.git/**`
