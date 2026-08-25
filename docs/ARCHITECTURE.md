# Architecture

Helix separates **substrate** from **semantics**.

## Kernel

The kernel owns durable, non-semantic building blocks:

- Agents and clone lineage
- Conversations, sessions, turns
- Append-only events (UUIDv7 ordered)
- Versioned artifacts
- Secrets and scoped configuration
- Local sandboxes + snapshots
- Experiments (`open` / `promoted` / `abandoned`)
- Mutation policy for immutable paths

Storage is SQLite under `.helix/helix.sqlite`, with artifact and sandbox blobs on
disk beside it. Rewinding a sandbox never rewrites the event log.

## Runtime

The runtime owns turn semantics:

1. `beginTurn` (optionally accepting the user message)
2. Assemble instructions + derived history
3. Call the model
4. Execute tools and append results
5. `finishTurn`

Model access is OpenAI-compatible. If no API key is present, an echo client keeps
local development and tests deterministic.

## Agent

The default agent adds identity prompts, durable memory injection, and the
bootstrap tool surface for shell, files, memory, lineage, and experiments.

## Policy

By default the agent cannot mutate `packages/kernel`. That keeps the event log,
lineage graph, and secret store trustworthy while still letting the agent evolve
almost everything above that boundary.
