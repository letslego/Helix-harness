import type {
  AgentRecord,
  ConversationRecord,
  EventRecord,
  HelixKernel,
  TurnRecord,
} from "@helix/kernel";

import type { ModelClient } from "./types.js";
import type { ChatMessage } from "./types.js";
import { ToolRegistry } from "./tools.js";

export interface TurnContext {
  kernel: HelixKernel;
  agent: AgentRecord;
  conversation: ConversationRecord;
  turn: TurnRecord;
  sessionId: string;
  repoRoot: string;
  model: string;
}

export interface RunTurnOptions {
  kernel: HelixKernel;
  agent: AgentRecord;
  conversation: ConversationRecord;
  userMessage: string;
  modelClient: ModelClient;
  model?: string;
  repoRoot: string;
  maxToolRoundTrips?: number;
  buildInstructions: (context: TurnContext) => Promise<ChatMessage[]> | ChatMessage[];
  registerTools: (
    tools: ToolRegistry,
    context: TurnContext,
  ) => Promise<void> | void;
  sessionId?: string | null;
  onEvent?: (event: EventRecord) => void;
}

export interface TurnResult {
  turnId: string;
  sessionId: string;
  assistantText: string;
  events: EventRecord[];
  toolRoundTrips: number;
}

export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const model = options.model ?? process.env.HELIX_MODEL ?? "gpt-4.1-mini";
  const maxToolRoundTrips = options.maxToolRoundTrips ?? 12;
  const { turn, session, events: initialEvents } = options.kernel.beginTurn({
    conversationId: options.conversation.id,
    sessionId: options.sessionId,
    userMessage: options.userMessage,
  });
  const emitted: EventRecord[] = [...initialEvents];
  const emit = (event: EventRecord) => {
    emitted.push(event);
    options.onEvent?.(event);
  };
  for (const event of initialEvents) options.onEvent?.(event);

  const context: TurnContext = {
    kernel: options.kernel,
    agent: options.agent,
    conversation: options.conversation,
    turn,
    sessionId: session.id,
    repoRoot: options.repoRoot,
    model,
  };

  const tools = new ToolRegistry();
  await options.registerTools(tools, context);
  const instructions = await options.buildInstructions(context);

  const history = buildHistoryMessages(options.kernel, options.conversation.id);
  const messages: ChatMessage[] = [
    ...instructions,
    ...history,
    { role: "user", content: options.userMessage },
  ];

  let assistantText = "";
  let toolRoundTrips = 0;

  while (toolRoundTrips <= maxToolRoundTrips) {
    const response = await options.modelClient.complete({
      model,
      messages,
      tools: tools.list(),
    });

    const assistantMessage = response.message;
    messages.push(assistantMessage);
    emit(
      options.kernel.appendEvent({
        conversationId: options.conversation.id,
        sessionId: session.id,
        turnId: turn.id,
        type: "messages",
        data: {
          messages: [
            {
              role: "assistant",
              content: assistantMessage.content,
              toolCalls: (assistantMessage.toolCalls ?? null) as never,
            },
          ],
          usage: (response.usage ?? null) as never,
        },
      }),
    );

    const toolCalls = assistantMessage.toolCalls ?? [];
    if (!toolCalls.length) {
      assistantText = assistantMessage.content;
      break;
    }

    toolRoundTrips += 1;
    for (const call of toolCalls) {
      emit(
        options.kernel.appendEvent({
          conversationId: options.conversation.id,
          sessionId: session.id,
          turnId: turn.id,
          type: "tool_requested",
          data: {
            toolCallId: call.id,
            name: call.name,
            arguments: call.arguments,
          },
        }),
      );
      const result = await tools.execute(call.name, call.arguments);
      const resultText =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      emit(
        options.kernel.appendEvent({
          conversationId: options.conversation.id,
          sessionId: session.id,
          turnId: turn.id,
          type: "tool_result",
          data: {
            toolCallId: call.id,
            name: call.name,
            result: result as import("@helix/kernel").JsonValue,
          },
        }),
      );
      messages.push({
        role: "tool",
        content: resultText,
        toolCallId: call.id,
        name: call.name,
      });
    }
  }

  emit(options.kernel.finishTurn(turn.id));
  return {
    turnId: turn.id,
    sessionId: session.id,
    assistantText,
    events: emitted,
    toolRoundTrips,
  };
}

function buildHistoryMessages(
  kernel: HelixKernel,
  conversationId: string,
): ChatMessage[] {
  const events = kernel.getEvents(conversationId, {
    direction: "asc",
    limit: 500,
    types: ["messages", "tool_result"],
  }).events;

  const messages: ChatMessage[] = [];
  for (const event of events) {
    if (event.type === "messages") {
      const batch = (event.data.messages as ChatMessage[] | undefined) ?? [];
      for (const message of batch) {
        if (message.role === "user" || message.role === "assistant") {
          // Skip empty assistant placeholders that only carry tool calls when
          // we already serialize tool results separately for prompt assembly.
          if (message.role === "assistant" && message.toolCalls?.length) {
            messages.push({
              role: "assistant",
              content: message.content || "(tool call)",
              toolCalls: message.toolCalls,
            });
          } else {
            messages.push({
              role: message.role,
              content:
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
            });
          }
        }
      }
    }
  }
  // Drop the trailing user message; runTurn appends the current one.
  if (messages.at(-1)?.role === "user") messages.pop();
  return messages;
}
