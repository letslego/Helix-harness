export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface AgentRecord {
  id: string;
  slug: string;
  name: string;
  parentAgentId?: string | null;
  lineageRootId: string;
  createdAt: string;
  metadata: JsonObject;
}

export interface ConversationRecord {
  id: string;
  agentId: string;
  slug: string;
  name: string;
  parentConversationId?: string | null;
  forkedFromEventId?: string | null;
  latestEventId?: string | null;
  createdAt: string;
  metadata: JsonObject;
}

export interface SessionRecord {
  id: string;
  conversationId: string;
  startedAt: string;
  endedAt?: string | null;
}

export interface TurnRecord {
  id: string;
  conversationId: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string | null;
  finishEventId?: string | null;
}

export type EventType =
  | "conversation_forked"
  | "session_started"
  | "session_ended"
  | "turn_started"
  | "turn_ended"
  | "messages"
  | "tool_requested"
  | "tool_result"
  | "artifact_written"
  | "sandbox_created"
  | "sandbox_started"
  | "sandbox_stopped"
  | "sandbox_snapshotted"
  | "memory_written"
  | "memory_forgotten"
  | "lineage_cloned"
  | "experiment_opened"
  | "experiment_closed"
  | "policy_denied"
  | "custom";

export interface EventRecord {
  id: string;
  conversationId: string;
  sessionId?: string | null;
  turnId?: string | null;
  type: EventType;
  createdAt: string;
  data: JsonObject;
}

export interface ArtifactVersion {
  id: string;
  agentId?: string | null;
  conversationId?: string | null;
  path: string;
  version: number;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
}

export interface SecretMetadata {
  id: string;
  scope: "global" | "agent" | "conversation";
  scopeId?: string | null;
  name: string;
  kind: "key" | "oauth";
  createdAt: string;
}

export interface SecretRecord extends SecretMetadata {
  value: JsonObject;
}

export interface MemoryEntry {
  id: string;
  agentId: string;
  key: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxRecord {
  id: string;
  conversationId: string;
  provider: "local" | "docker";
  status: "created" | "running" | "stopped";
  workDir: string;
  createdAt: string;
  metadata: JsonObject;
}

export interface SnapshotRecord {
  id: string;
  sandboxId: string;
  createdAt: string;
  note?: string | null;
  path: string;
}

export interface LineageEdge {
  id: string;
  parentAgentId: string;
  childAgentId: string;
  reason: string;
  createdAt: string;
  eventId?: string | null;
}

export interface ExperimentRecord {
  id: string;
  agentId: string;
  conversationId: string;
  title: string;
  hypothesis: string;
  status: "open" | "promoted" | "abandoned";
  createdAt: string;
  closedAt?: string | null;
  result?: string | null;
}

export interface EventQuery {
  cursor?: string | null;
  direction?: "asc" | "desc";
  limit?: number;
  sessionId?: string | null;
  turnId?: string | null;
  types?: EventType[];
}

export interface GetEventsResult {
  events: EventRecord[];
  nextCursor?: string | null;
}

export interface PolicyRules {
  /** Paths the agent may not modify relative to the repo root. */
  immutablePaths: string[];
  /** Maximum model USD spend per calendar day (soft guard). */
  dailyBudgetUsd: number;
  /** Whether the agent may rewrite kernel packages. */
  allowKernelMutation: boolean;
}
