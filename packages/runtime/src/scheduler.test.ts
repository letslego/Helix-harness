import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SchedulerStore } from "./scheduler.js";

const homes: string[] = [];

afterEach(() => {
  while (homes.length) {
    const home = homes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

describe("SchedulerStore", () => {
  it("fires interval tasks and advances the grid", () => {
    const home = mkdtempSync(join(tmpdir(), "helix-sched-"));
    homes.push(home);
    const store = new SchedulerStore(home);
    const task = store.schedule({
      agentId: "a",
      conversationId: "c",
      name: "tick",
      command: "echo hi",
      everyMs: 60_000,
    });
    const originalNext = task.nextFireAt;
    const dueNow = store.due(new Date(originalNext).getTime() + 1);
    expect(dueNow).toHaveLength(1);
    store.markFired(task.id, new Date(originalNext).getTime() + 1);
    const updated = store.get(task.id)!;
    expect(new Date(updated.nextFireAt).getTime()).toBeGreaterThan(
      new Date(originalNext).getTime(),
    );
  });
});
