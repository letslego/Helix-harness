import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { ToolRegistry, TurnContext } from "@helix/runtime";
import { runShellCommand } from "@helix/runtime";

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing string argument: ${key}`);
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function registerAgentTools(
  tools: ToolRegistry,
  context: TurnContext,
): void {
  tools.register({
    name: "shell",
    description:
      "Run a shell command in the conversation sandbox working directory.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeoutMs: {
          type: "number",
          description: "Optional timeout in milliseconds",
        },
      },
      required: ["command"],
    },
    execute: async (args) => {
      const sandbox = ensureSandbox(context);
      const result = await runShellCommand(stringArg(args, "command"), {
        cwd: sandbox.workDir,
        timeoutMs:
          typeof args.timeoutMs === "number" ? args.timeoutMs : 60_000,
      });
      return result;
    },
  });

  tools.register({
    name: "read_file",
    description:
      "Read a UTF-8 text file relative to the repo root or an absolute path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxChars: { type: "number" },
      },
      required: ["path"],
    },
    execute: (args) => {
      const path = resolvePath(context.repoRoot, stringArg(args, "path"));
      const maxChars =
        typeof args.maxChars === "number" ? args.maxChars : 100_000;
      const content = readFileSync(path, "utf8");
      return {
        path,
        truncated: content.length > maxChars,
        content:
          content.length > maxChars
            ? `${content.slice(0, maxChars)}\n...[truncated]`
            : content,
      };
    },
  });

  tools.register({
    name: "write_file",
    description:
      "Write a UTF-8 text file. Enforces kernel immutability policy.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    execute: (args) => {
      const abs = resolvePath(context.repoRoot, stringArg(args, "path"));
      const rel = relative(context.repoRoot, abs);
      if (!rel.startsWith("..")) {
        context.kernel.assertMutablePath(rel);
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, stringArg(args, "content"));
      context.kernel.writeArtifact({
        path: `files/${rel || abs}`,
        bytes: stringArg(args, "content"),
        agentId: context.agent.id,
        conversationId: context.conversation.id,
      });
      return { ok: true, path: abs };
    },
  });

  tools.register({
    name: "remember",
    description: "Persist a durable memory for this agent.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string" },
        content: { type: "string" },
      },
      required: ["key", "content"],
    },
    execute: (args) => {
      const entry = context.kernel.remember(
        context.agent.id,
        stringArg(args, "key"),
        stringArg(args, "content"),
      );
      context.kernel.appendEvent({
        conversationId: context.conversation.id,
        sessionId: context.sessionId,
        turnId: context.turn.id,
        type: "memory_written",
        data: { key: entry.key, content: entry.content },
      });
      return entry;
    },
  });

  tools.register({
    name: "forget",
    description: "Delete a durable memory key for this agent.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string" },
      },
      required: ["key"],
    },
    execute: (args) => {
      const key = stringArg(args, "key");
      const ok = context.kernel.forget(context.agent.id, key);
      if (ok) {
        context.kernel.appendEvent({
          conversationId: context.conversation.id,
          sessionId: context.sessionId,
          turnId: context.turn.id,
          type: "memory_forgotten",
          data: { key },
        });
      }
      return { ok, key };
    },
  });

  tools.register({
    name: "list_memories",
    description: "List durable memories for this agent.",
    parameters: { type: "object", properties: {} },
    execute: () => context.kernel.listMemories(context.agent.id),
  });

  tools.register({
    name: "inspect_events",
    description: "Inspect recent conversation events from the immutable log.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number" },
        types: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    execute: (args) => {
      const limit = typeof args.limit === "number" ? args.limit : 40;
      const types = Array.isArray(args.types)
        ? (args.types as string[])
        : undefined;
      return context.kernel.getEvents(context.conversation.id, {
        direction: "desc",
        limit,
        types: types as never,
      }).events;
    },
  });

  tools.register({
    name: "snapshot_sandbox",
    description: "Snapshot the current sandbox filesystem.",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string" },
      },
    },
    execute: (args) => {
      const sandbox = ensureSandbox(context);
      return context.kernel.snapshotSandbox(
        sandbox.id,
        optionalString(args, "note"),
      );
    },
  });

  tools.register({
    name: "rewind_sandbox",
    description: "Rewind the sandbox to a previous snapshot id.",
    parameters: {
      type: "object",
      properties: {
        snapshotId: { type: "string" },
      },
      required: ["snapshotId"],
    },
    execute: (args) => {
      const sandbox = ensureSandbox(context);
      return context.kernel.rewindSandbox(
        sandbox.id,
        stringArg(args, "snapshotId"),
      );
    },
  });

  tools.register({
    name: "clone_agent",
    description:
      "Clone this agent into a lineage child. Use when branching a self-improvement approach.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        reason: { type: "string" },
      },
      required: ["reason"],
    },
    execute: (args) => {
      const result = context.kernel.cloneAgent(context.agent.id, {
        name: optionalString(args, "name"),
        reason: stringArg(args, "reason"),
      });
      context.kernel.appendEvent({
        conversationId: context.conversation.id,
        sessionId: context.sessionId,
        turnId: context.turn.id,
        type: "lineage_cloned",
        data: {
          parentAgentId: context.agent.id,
          childAgentId: result.agent.id,
          reason: result.edge.reason,
        },
      });
      return result;
    },
  });

  tools.register({
    name: "open_experiment",
    description:
      "Open a tracked self-improvement experiment with a hypothesis.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        hypothesis: { type: "string" },
      },
      required: ["title", "hypothesis"],
    },
    execute: (args) =>
      context.kernel.openExperiment({
        agentId: context.agent.id,
        conversationId: context.conversation.id,
        title: stringArg(args, "title"),
        hypothesis: stringArg(args, "hypothesis"),
      }),
  });

  tools.register({
    name: "close_experiment",
    description: "Close an experiment as promoted or abandoned.",
    parameters: {
      type: "object",
      properties: {
        experimentId: { type: "string" },
        status: { type: "string", enum: ["promoted", "abandoned"] },
        result: { type: "string" },
      },
      required: ["experimentId", "status"],
    },
    execute: (args) => {
      const status = stringArg(args, "status");
      if (status !== "promoted" && status !== "abandoned") {
        throw new Error("status must be promoted or abandoned");
      }
      return context.kernel.closeExperiment(
        stringArg(args, "experimentId"),
        status,
        optionalString(args, "result"),
      );
    },
  });

  tools.register({
    name: "list_experiments",
    description: "List experiments for this agent.",
    parameters: { type: "object", properties: {} },
    execute: () => context.kernel.listExperiments(context.agent.id),
  });

  tools.register({
    name: "list_lineage",
    description: "Show clone lineage edges for this agent.",
    parameters: { type: "object", properties: {} },
    execute: () => context.kernel.listLineage(context.agent.id),
  });
}

function ensureSandbox(context: TurnContext) {
  const existing = context.kernel.listSandboxes(context.conversation.id)[0];
  if (existing) {
    if (existing.status !== "running") {
      context.kernel.startSandbox(existing.id);
    }
    return context.kernel.getSandbox(existing.id)!;
  }
  const created = context.kernel.createSandbox({
    conversationId: context.conversation.id,
    provider: "local",
    metadata: { repoRoot: context.repoRoot },
  });
  // Seed sandbox with a workspace pointer file.
  writeFileSync(
    join(created.workDir, "README.txt"),
    `Helix sandbox for conversation ${context.conversation.slug}\nRepo: ${context.repoRoot}\n`,
  );
  return context.kernel.startSandbox(created.id);
}

function resolvePath(repoRoot: string, input: string): string {
  if (input.startsWith("/")) return resolve(input);
  return resolve(repoRoot, input);
}
