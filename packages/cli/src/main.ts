#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildHelixInstructions,
  registerHelixTools,
} from "@helix/agent";
import { HelixKernel } from "@helix/kernel";
import {
  createModelClientFromEnv,
  runTurn,
  type ModelClient,
} from "@helix/runtime";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(start = process.cwd()): string {
  let current = resolve(start);
  for (;;) {
    if (
      existsSync(resolve(current, "package.json")) &&
      existsSync(resolve(current, "packages/kernel"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Fallback: packages/cli/src -> repo root
  return resolve(__dirname, "../../..");
}

function loadDotEnv(repoRoot: string): void {
  const path = resolve(repoRoot, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function helixHome(repoRoot: string): string {
  return resolve(repoRoot, process.env.HELIX_HOME ?? ".helix");
}

function usage(): never {
  console.log(`Helix — recursive agent harness

Usage:
  helix                 Start or resume the default agent chat
  helix chat            Interactive REPL chat
  helix once <message>  Single-turn non-interactive message
  helix list            List agents and conversations
  helix events [n]      Tail recent events (default 30)
  helix fresh           Wipe local state and recreate defaults
  helix status          Show home path, agent, policy
  helix help            Show this help
`);
  process.exit(0);
}

function ensureDefaults(kernel: HelixKernel): {
  agent: ReturnType<HelixKernel["createAgent"]>;
  conversation: ReturnType<HelixKernel["createConversation"]>;
} {
  let agent = kernel.getAgent("helix");
  if (!agent) {
    agent = kernel.createAgent({ name: "Helix", slug: "helix" });
  }
  let conversation =
    kernel.getConversation("main", agent.id) ??
    kernel.listConversations(agent.id)[0];
  if (!conversation) {
    conversation = kernel.createConversation({
      agentId: agent.id,
      name: "main",
      slug: "main",
    });
  }
  return { agent, conversation };
}

async function cmdList(kernel: HelixKernel): Promise<void> {
  for (const agent of kernel.listAgents()) {
    console.log(`agent ${agent.slug} (${agent.name}) id=${agent.id}`);
    for (const conversation of kernel.listConversations(agent.id)) {
      console.log(
        `  conversation ${conversation.slug} (${conversation.name}) events_head=${conversation.latestEventId ?? "-"}`,
      );
    }
  }
}

async function cmdEvents(kernel: HelixKernel, limit: number): Promise<void> {
  const { conversation } = ensureDefaults(kernel);
  const events = kernel.getEvents(conversation.id, {
    direction: "desc",
    limit,
  }).events;
  for (const event of events.reverse()) {
    const summary = JSON.stringify(event.data).slice(0, 160);
    console.log(`${event.createdAt} ${event.type} ${event.id} ${summary}`);
  }
}

async function cmdStatus(kernel: HelixKernel, repoRoot: string): Promise<void> {
  const { agent, conversation } = ensureDefaults(kernel);
  const policy = kernel.getPolicy();
  console.log(
    JSON.stringify(
      {
        repoRoot,
        home: kernel.paths.home,
        agent: { slug: agent.slug, name: agent.name, id: agent.id },
        conversation: {
          slug: conversation.slug,
          id: conversation.id,
          latestEventId: conversation.latestEventId,
        },
        policy,
        model: process.env.HELIX_MODEL ?? "gpt-4.1-mini",
        modelMode: process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY
          ? "live"
          : "echo",
      },
      null,
      2,
    ),
  );
}

async function cmdFresh(kernel: HelixKernel): Promise<void> {
  kernel.wipeAll();
  const { agent, conversation } = ensureDefaults(kernel);
  console.log(
    `Fresh state ready. agent=${agent.slug} conversation=${conversation.slug}`,
  );
}

async function runOnce(
  kernel: HelixKernel,
  repoRoot: string,
  message: string,
  modelClient: ModelClient,
): Promise<void> {
  const { agent, conversation } = ensureDefaults(kernel);
  const result = await runTurn({
    kernel,
    agent,
    conversation,
    userMessage: message,
    modelClient,
    repoRoot,
    buildInstructions: buildHelixInstructions,
    registerTools: registerHelixTools,
    onEvent: (event) => {
      if (event.type === "tool_requested") {
        console.error(`→ tool ${String(event.data.name)}`);
      } else if (event.type === "tool_result") {
        console.error(`← tool ${String(event.data.name)}`);
      }
    },
  });
  console.log(result.assistantText || "(no assistant text)");
}

async function cmdChat(
  kernel: HelixKernel,
  repoRoot: string,
  modelClient: ModelClient,
): Promise<void> {
  const { agent, conversation } = ensureDefaults(kernel);
  console.log(
    `Helix chat — agent=${agent.slug} conversation=${conversation.slug}`,
  );
  console.log(
    process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY
      ? `Model: ${process.env.HELIX_MODEL ?? "gpt-4.1-mini"}`
      : "Model: echo (set OPENAI_API_KEY for live calls)",
  );
  console.log("Type /exit to quit, /events to show recent events.\n");

  const rl = createInterface({ input, output });
  let sessionId: string | null = null;
  try {
    for (;;) {
      const line = (await rl.question("you> ")).trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/events") {
        await cmdEvents(kernel, 20);
        continue;
      }
      const result = await runTurn({
        kernel,
        agent,
        conversation,
        userMessage: line,
        modelClient,
        repoRoot,
        sessionId,
        buildInstructions: buildHelixInstructions,
        registerTools: registerHelixTools,
        onEvent: (event) => {
          if (event.type === "tool_requested") {
            console.error(`→ tool ${String(event.data.name)}`);
          }
        },
      });
      sessionId = result.sessionId;
      console.log(`helix> ${result.assistantText || "(no assistant text)"}\n`);
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const repoRoot = findRepoRoot();
  loadDotEnv(repoRoot);
  const args = process.argv.slice(2);
  const command = args[0] ?? "chat";

  if (command === "help" || command === "--help" || command === "-h") {
    usage();
  }

  const kernel = new HelixKernel(helixHome(repoRoot));
  const modelClient = createModelClientFromEnv();

  try {
    switch (command) {
      case "chat":
        await cmdChat(kernel, repoRoot, modelClient);
        break;
      case "once": {
        const message = args.slice(1).join(" ").trim();
        if (!message) {
          console.error("Usage: helix once <message>");
          process.exit(1);
        }
        await runOnce(kernel, repoRoot, message, modelClient);
        break;
      }
      case "list":
        await cmdList(kernel);
        break;
      case "events": {
        const limit = Number(args[1] ?? "30");
        await cmdEvents(kernel, Number.isFinite(limit) ? limit : 30);
        break;
      }
      case "fresh":
        await cmdFresh(kernel);
        break;
      case "status":
        await cmdStatus(kernel, repoRoot);
        break;
      default:
        // Treat unknown first token as a one-shot message for convenience.
        if (!args[0]?.startsWith("-")) {
          await runOnce(kernel, repoRoot, args.join(" "), modelClient);
        } else {
          usage();
        }
    }
  } finally {
    kernel.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
