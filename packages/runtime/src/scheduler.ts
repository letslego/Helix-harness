import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { uuidv7, nowIso } from "@helix/kernel";

export type MissedFirePolicy = "drop" | "catch_up_one" | "catch_up_all";

export interface ScheduledTask {
  id: string;
  agentId: string;
  conversationId: string;
  name: string;
  command: string;
  /** Cron-like every N milliseconds, or null for one-shot. */
  everyMs: number | null;
  /** Absolute fire time for one-shot tasks. */
  at?: string | null;
  missedFirePolicy: MissedFirePolicy;
  enabled: boolean;
  createdAt: string;
  lastFiredAt?: string | null;
  nextFireAt: string;
  completed: boolean;
  reportPrompt?: string | null;
}

export class SchedulerStore {
  private readonly path: string;
  private tasks: ScheduledTask[] = [];

  constructor(home: string) {
    mkdirSync(home, { recursive: true });
    this.path = join(home, "scheduler.json");
    this.load();
  }

  list(agentId?: string): ScheduledTask[] {
    return this.tasks.filter((task) =>
      agentId ? task.agentId === agentId : true,
    );
  }

  get(id: string): ScheduledTask | undefined {
    return this.tasks.find((task) => task.id === id);
  }

  schedule(input: {
    agentId: string;
    conversationId: string;
    name: string;
    command: string;
    everyMs?: number | null;
    at?: string | null;
    missedFirePolicy?: MissedFirePolicy;
    reportPrompt?: string | null;
  }): ScheduledTask {
    const now = Date.now();
    const everyMs = input.everyMs ?? null;
    const at = input.at ?? null;
    if (!everyMs && !at) {
      throw new Error("Provide everyMs or at");
    }
    const nextFireAt = at
      ? new Date(at).toISOString()
      : new Date(now + (everyMs ?? 0)).toISOString();
    const task: ScheduledTask = {
      id: uuidv7(),
      agentId: input.agentId,
      conversationId: input.conversationId,
      name: input.name,
      command: input.command,
      everyMs,
      at,
      missedFirePolicy: input.missedFirePolicy ?? "catch_up_one",
      enabled: true,
      createdAt: nowIso(),
      lastFiredAt: null,
      nextFireAt,
      completed: false,
      reportPrompt: input.reportPrompt ?? null,
    };
    this.tasks.push(task);
    this.save();
    return task;
  }

  cancel(id: string): boolean {
    const task = this.get(id);
    if (!task) return false;
    task.enabled = false;
    this.save();
    return true;
  }

  delete(id: string): boolean {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((task) => task.id !== id);
    this.save();
    return this.tasks.length < before;
  }

  due(now = Date.now()): ScheduledTask[] {
    return this.tasks.filter(
      (task) =>
        task.enabled &&
        !task.completed &&
        new Date(task.nextFireAt).getTime() <= now,
    );
  }

  markFired(id: string, now = Date.now()): ScheduledTask | undefined {
    const task = this.get(id);
    if (!task) return undefined;
    task.lastFiredAt = new Date(now).toISOString();
    if (task.everyMs && task.everyMs > 0) {
      // Stay on grid relative to previous nextFireAt.
      let next = new Date(task.nextFireAt).getTime() + task.everyMs;
      if (task.missedFirePolicy === "drop") {
        while (next < now) next += task.everyMs;
      } else if (task.missedFirePolicy === "catch_up_one") {
        if (next < now) next = now + task.everyMs;
      } // catch_up_all: advance one slot only; caller may fire repeatedly
      task.nextFireAt = new Date(next).toISOString();
    } else {
      task.completed = true;
      task.enabled = false;
    }
    this.save();
    return task;
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.tasks = [];
      return;
    }
    this.tasks = JSON.parse(readFileSync(this.path, "utf8")) as ScheduledTask[];
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.tasks, null, 2));
  }
}
