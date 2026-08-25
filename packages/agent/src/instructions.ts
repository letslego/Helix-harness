import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ChatMessage, ToolRegistry, TurnContext } from "@helix/runtime";

import { registerAgentTools } from "./tools.js";

export function loadIdentityPrompt(repoRoot: string): string {
  return readFileSync(join(repoRoot, "prompts/me.md"), "utf8").trim();
}

export function loadSelfMap(repoRoot: string): string {
  try {
    return readFileSync(join(repoRoot, "docs/SELF.md"), "utf8").trim();
  } catch {
    return "Self-map missing.";
  }
}

export async function buildHelixInstructions(
  context: TurnContext,
): Promise<ChatMessage[]> {
  const memories = context.kernel.listMemories(context.agent.id);
  const memoryBlock =
    memories.length === 0
      ? "(no durable memories yet)"
      : memories
          .map((entry) => `- ${entry.key}: ${entry.content}`)
          .join("\n");

  const policy = context.kernel.getPolicy();
  return [
    {
      role: "system",
      content: loadIdentityPrompt(context.repoRoot),
    },
    {
      role: "developer",
      content: `Your configured display name is ${JSON.stringify(context.agent.name)} (slug ${context.agent.slug}).`,
    },
    {
      role: "developer",
      content: `Repository root: ${context.repoRoot}
Self-map:
${loadSelfMap(context.repoRoot)}

Policy:
- allowKernelMutation: ${policy.allowKernelMutation}
- dailyBudgetUsd: ${policy.dailyBudgetUsd}
- immutablePaths: ${policy.immutablePaths.join(", ")}

Durable memory:
${memoryBlock}`,
    },
  ];
}

export async function registerHelixTools(
  tools: ToolRegistry,
  context: TurnContext,
): Promise<void> {
  registerAgentTools(tools, context);
}
