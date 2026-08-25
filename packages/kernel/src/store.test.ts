import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HelixKernel } from "./store.js";

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "helix-kernel-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  while (homes.length) {
    const home = homes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

describe("HelixKernel", () => {
  it("creates agents, conversations, and append-only events", () => {
    const kernel = new HelixKernel(tempHome());
    const agent = kernel.createAgent({ name: "Atlas" });
    const conversation = kernel.createConversation({
      agentId: agent.id,
      name: "main",
    });
    const { turn } = kernel.beginTurn({
      conversationId: conversation.id,
      userMessage: "hello",
    });
    kernel.appendEvent({
      conversationId: conversation.id,
      sessionId: turn.sessionId,
      turnId: turn.id,
      type: "messages",
      data: { messages: [{ role: "assistant", content: "hi" }] },
    });
    kernel.finishTurn(turn.id);

    const events = kernel.getEvents(conversation.id, { direction: "asc" }).events;
    expect(events.map((e) => e.type)).toEqual([
      "session_started",
      "turn_started",
      "messages",
      "messages",
      "turn_ended",
    ]);
    expect(events[2]?.data.messages).toEqual([
      { role: "user", content: "hello" },
    ]);
    kernel.close();
  });

  it("tracks lineage when cloning agents", () => {
    const kernel = new HelixKernel(tempHome());
    const parent = kernel.createAgent({ name: "Parent" });
    const { agent: child, edge } = kernel.cloneAgent(parent.id, {
      reason: "experiment with memory tools",
    });
    expect(child.parentAgentId).toBe(parent.id);
    expect(child.lineageRootId).toBe(parent.lineageRootId);
    expect(edge.reason).toBe("experiment with memory tools");
    expect(kernel.listLineage(parent.id)).toHaveLength(1);
    kernel.close();
  });

  it("forks conversations and preserves prior events", () => {
    const kernel = new HelixKernel(tempHome());
    const agent = kernel.createAgent({ name: "A" });
    const conversation = kernel.createConversation({
      agentId: agent.id,
      name: "c",
    });
    const { turn } = kernel.beginTurn({
      conversationId: conversation.id,
      userMessage: "seed",
    });
    kernel.finishTurn(turn.id);
    const forked = kernel.forkConversation(conversation.id, { name: "c-fork" });
    const events = kernel.getEvents(forked.id, { direction: "asc", limit: 1000 })
      .events;
    expect(events.some((e) => e.type === "conversation_forked")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "messages" &&
          JSON.stringify(e.data).includes("seed"),
      ),
    ).toBe(true);
    kernel.close();
  });

  it("enforces immutable path policy", () => {
    const kernel = new HelixKernel(tempHome());
    expect(() => kernel.assertMutablePath("packages/kernel/src/store.ts")).toThrow(
      /immutable path/,
    );
    expect(() => kernel.assertMutablePath("packages/agent/src/tools.ts")).not.toThrow();
    kernel.close();
  });

  it("snapshots and rewinds local sandboxes", () => {
    const kernel = new HelixKernel(tempHome());
    const agent = kernel.createAgent({ name: "A" });
    const conversation = kernel.createConversation({
      agentId: agent.id,
      name: "c",
    });
    const sandbox = kernel.createSandbox({ conversationId: conversation.id });
    kernel.startSandbox(sandbox.id);
    writeFileSync(join(sandbox.workDir, "note.txt"), "v1");
    const snap = kernel.snapshotSandbox(sandbox.id, "before mutate");
    writeFileSync(join(sandbox.workDir, "note.txt"), "v2");
    kernel.rewindSandbox(sandbox.id, snap.id);
    expect(readFileSync(join(sandbox.workDir, "note.txt"), "utf8")).toBe("v1");
    kernel.close();
  });

  it("stores durable memory outside the conversation log", () => {
    const kernel = new HelixKernel(tempHome());
    const agent = kernel.createAgent({ name: "A" });
    kernel.remember(agent.id, "user.name", "Amit");
    expect(kernel.listMemories(agent.id)[0]?.content).toBe("Amit");
    expect(kernel.forget(agent.id, "user.name")).toBe(true);
    expect(kernel.listMemories(agent.id)).toHaveLength(0);
    kernel.close();
  });
});
