import type {
  ChatMessage,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ToolDefinition,
} from "./types.js";

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
}

export class OpenAICompatibleClient implements ModelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(config: OpenAICompatibleConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
    this.defaultHeaders = config.defaultHeaders ?? {};
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const body = {
      model: request.model,
      messages: request.messages.map(toProviderMessage),
      tools: request.tools?.map(toProviderTool),
      max_completion_tokens: request.maxOutputTokens,
    };
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...this.defaultHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Model request failed (${response.status}): ${text}`);
    }
    const json = (await response.json()) as {
      choices: Array<{
        message: {
          role: string;
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = json.choices[0]?.message;
    if (!choice) throw new Error("Model returned no choices");
    const message: ChatMessage = {
      role: "assistant",
      content: choice.content ?? "",
      toolCalls: choice.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
    };
    return {
      message,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/** Deterministic client for offline tests and demos. */
export class EchoModelClient implements ModelClient {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const lastUserIndex = [...request.messages]
      .map((message, index) => ({ message, index }))
      .reverse()
      .find(({ message }) => message.role === "user")?.index;
    const lastUser =
      lastUserIndex === undefined ? undefined : request.messages[lastUserIndex];
    const text = lastUser?.content ?? "";
    const alreadyUsedTools =
      lastUserIndex !== undefined &&
      request.messages
        .slice(lastUserIndex + 1)
        .some((message) => message.role === "tool" || message.toolCalls?.length);

    if (text.startsWith("/tool ") && !alreadyUsedTools) {
      const [, name, ...rest] = text.split(" ");
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_echo_1",
              name: name ?? "shell",
              arguments: JSON.stringify({
                command: rest.join(" ") || "echo hi",
              }),
            },
          ],
        },
      };
    }
    if (text.startsWith("/tool ") && alreadyUsedTools) {
      return {
        message: {
          role: "assistant",
          content: `tool finished for: ${text}`,
        },
        usage: { inputTokens: text.length, outputTokens: 20 },
      };
    }
    return {
      message: {
        role: "assistant",
        content: `echo: ${text}`,
      },
      usage: { inputTokens: text.length, outputTokens: text.length + 6 },
    };
  }
}

function toProviderMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }
  if (message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  const role = message.role === "developer" ? "system" : message.role;
  return { role, content: message.content };
}

function toProviderTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

export function createModelClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ModelClient {
  const apiKey = env.OPENAI_API_KEY ?? env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new EchoModelClient();
  }
  const baseUrl =
    env.OPENAI_BASE_URL ??
    (env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : undefined);
  return new OpenAICompatibleClient({
    apiKey,
    baseUrl,
    defaultHeaders: env.OPENROUTER_API_KEY
      ? {
          "HTTP-Referer": "https://github.com/helix-harness/helix",
          "X-Title": "Helix",
        }
      : {},
  });
}
