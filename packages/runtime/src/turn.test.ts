import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HelixKernel } from "@helix/kernel";

import { EchoModelClient } from "./model.js";
import { ToolRegistry } from "./tools.js";
import { runTurn } from "./turn.js";

const homes: string[] = [];

afterEach(() => {
  while (homes.length) {
    const home = homes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

describe("runTurn", () => {
  it("runs an echo turn and persists events", async () => {
    const home = mkdtempSync(join(tmpdir(), "helix-runtime-"));
    homes.push(home);
    const kernel = new HelixKernel(home);
    const agent = kernel.createAgent({ name: "Atlas" });
    const conversation = kernel.createConversation({
      agentId: agent.id,
      name: "main",
    });

    const result = await runTurn({
      kernel,
      agent,
      conversation,
      userMessage: "ping",
      modelClient: new EchoModelClient(),
      repoRoot: process.cwd(),
      buildInstructions: () => [
        { role: "system", content: "You are a test agent." },
      ],
      registerTools: (tools: ToolRegistry) => {
        tools.register({
          name: "noop",
          description: "No operation",
          parameters: {
            type: "object",
            properties: {},
          },
          execute: () => ({ ok: true }),
        });
      },
    });

    expect(result.assistantText).toBe("echo: ping");
    expect(result.events.some((event) => event.type === "turn_ended")).toBe(
      true,
    );
    kernel.close();
  });
});
