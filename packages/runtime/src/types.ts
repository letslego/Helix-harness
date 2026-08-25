export type Role = "system" | "developer" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
}

export interface ModelResponse {
  message: ChatMessage;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
