# Helix

Helix is a recursive self-improving agent harness. It gives an agent durable
state, an append-only event log, sandboxed execution, and first-class lineage so
it can modify its own prompts, tools, and policies over time without losing
history.

## Why Helix

Most agent stacks freeze the harness and only let the model touch memory or
skills. Helix treats the harness as editable surface area:

- **Immutable kernel** — conversations, events, artifacts, secrets, sandboxes,
  and lineage live in a SQLite-backed substrate the agent cannot casually erase.
- **Mutable agent surface** — prompts, tools, adapters, and runtime policy can
  evolve at runtime under an explicit experiment workflow.
- **Lineage** — cloning an agent records parent/child edges and reasons, so
  failed approaches remain inspectable.
- **Sandbox snapshots** — filesystem experiments can be snapshotted and rewound
  without rewriting the canonical event log.
- **Single language** — the whole stack is TypeScript on Node 22+, so the agent
  can read and change the same codebase it runs.

## Quick start

Requirements: Node.js 22+ and [pnpm](https://pnpm.io).

```bash
git clone <your-fork-or-repo-url> helix
cd helix
pnpm install
cp .env.example .env   # optional: add OPENAI_API_KEY for live models
./helix.sh             # interactive chat (echo model without an API key)
```

Useful commands:

```bash
./helix.sh once "Remember that my name is Amit"
./helix.sh list
./helix.sh events 50
./helix.sh status
./helix.sh fresh       # wipe .helix state and start clean
```

Without `OPENAI_API_KEY` (or `OPENROUTER_API_KEY`), Helix uses a local echo
model so the harness, tools, and event log can be exercised offline. Prefix a
message with `/tool shell echo hi` under the echo client to force a tool call.

## Architecture

```text
CLI / adapters
  -> runtime turn loop (prompt assembly, model calls, tools)
    -> agent tools + prompts (mutable)
      -> kernel (append-only events, agents, lineage, sandboxes, secrets)
```

| Package | Role |
| --- | --- |
| `@helix/kernel` | Durable substrate and policy boundary |
| `@helix/runtime` | Turn loop, model clients, tool registry |
| `@helix/agent` | Default identity, tools, experiment helpers |
| `@helix/cli` | `helix` command line |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SELF.md](docs/SELF.md).

## Built-in tools

- Host/sandbox: `shell`, `read_file`, `write_file`, `snapshot_sandbox`, `rewind_sandbox`
- Memory: `remember`, `forget`, `list_memories`
- Introspection: `inspect_events`
- Self-improvement: `open_experiment`, `close_experiment`, `list_experiments`,
  `clone_agent`, `list_lineage`

## Self-improvement loop

1. Open an experiment with a hypothesis.
2. Change agent/runtime code or prompts (kernel paths are blocked by policy).
3. Validate with tests or sandbox commands.
4. Promote or abandon the experiment.
5. Optionally clone the agent to keep a lineage branch.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
```

## License

MIT
