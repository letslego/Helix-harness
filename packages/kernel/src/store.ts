import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { nowIso, uuidv7 } from "./ids.js";
import type {
  AgentRecord,
  ArtifactVersion,
  ConversationRecord,
  EventQuery,
  EventRecord,
  EventType,
  ExperimentRecord,
  GetEventsResult,
  JsonObject,
  LineageEdge,
  MemoryEntry,
  PolicyRules,
  SandboxRecord,
  SecretMetadata,
  SecretRecord,
  SessionRecord,
  SnapshotRecord,
  TurnRecord,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  parent_agent_id TEXT,
  lineage_root_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_conversation_id TEXT,
  forked_from_event_id TEXT,
  latest_event_id TEXT,
  created_at TEXT NOT NULL,
  metadata TEXT NOT NULL,
  UNIQUE(agent_id, slug)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  finish_event_id TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_conv_id ON events(conversation_id, id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  conversation_id TEXT,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  UNIQUE(agent_id, conversation_id, path, version)
);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(scope, scope_id, name)
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, key)
);

CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  work_dir TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT,
  path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lineage (
  id TEXT PRIMARY KEY,
  parent_agent_id TEXT NOT NULL,
  child_agent_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  event_id TEXT
);

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  result TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface KernelPaths {
  home: string;
  dbPath: string;
  artifactsDir: string;
  sandboxesDir: string;
  snapshotsDir: string;
}

export function resolveKernelPaths(home: string): KernelPaths {
  const resolved = resolve(home);
  return {
    home: resolved,
    dbPath: join(resolved, "helix.sqlite"),
    artifactsDir: join(resolved, "artifacts"),
    sandboxesDir: join(resolved, "sandboxes"),
    snapshotsDir: join(resolved, "snapshots"),
  };
}

export const DEFAULT_POLICY: PolicyRules = {
  immutablePaths: [
    "packages/kernel",
    "LICENSE",
    ".git",
  ],
  dailyBudgetUsd: 25,
  allowKernelMutation: false,
};

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

/** node:sqlite rejects undefined; coerce to null. */
function sqlVal(
  value: string | number | bigint | null | undefined,
): string | number | bigint | null {
  return value === undefined ? null : value;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "item";
}

export class HelixKernel {
  readonly paths: KernelPaths;
  readonly db: DatabaseSync;
  private policy: PolicyRules;

  constructor(home: string, policy: PolicyRules = DEFAULT_POLICY) {
    this.paths = resolveKernelPaths(home);
    mkdirSync(this.paths.home, { recursive: true });
    mkdirSync(this.paths.artifactsDir, { recursive: true });
    mkdirSync(this.paths.sandboxesDir, { recursive: true });
    mkdirSync(this.paths.snapshotsDir, { recursive: true });
    this.db = new DatabaseSync(this.paths.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.policy = policy;
    this.ensureMeta("schema_version", "1");
  }

  close(): void {
    this.db.close();
  }

  getPolicy(): PolicyRules {
    return { ...this.policy, immutablePaths: [...this.policy.immutablePaths] };
  }

  setPolicy(policy: Partial<PolicyRules>): PolicyRules {
    this.policy = {
      ...this.policy,
      ...policy,
      immutablePaths: policy.immutablePaths ?? this.policy.immutablePaths,
    };
    this.ensureMeta("policy", JSON.stringify(this.policy));
    return this.getPolicy();
  }

  assertMutablePath(repoRelativePath: string): void {
    const normalized = repoRelativePath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!this.policy.allowKernelMutation) {
      for (const blocked of this.policy.immutablePaths) {
        if (
          normalized === blocked ||
          normalized.startsWith(`${blocked}/`)
        ) {
          throw new Error(
            `Policy denied mutation of immutable path: ${normalized}`,
          );
        }
      }
    }
  }

  // --- Agents ----------------------------------------------------------------

  listAgents(): AgentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM agents ORDER BY created_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapAgent);
  }

  getAgent(idOrSlug: string): AgentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE id = ? OR slug = ?")
      .get(idOrSlug, idOrSlug) as Record<string, unknown> | undefined;
    return row ? mapAgent(row) : null;
  }

  createAgent(input: {
    name: string;
    slug?: string;
    parentAgentId?: string | null;
    metadata?: JsonObject;
  }): AgentRecord {
    const id = uuidv7();
    const slug = uniqueSlug(
      this,
      "agents",
      input.slug ?? slugify(input.name),
    );
    const parent = input.parentAgentId
      ? this.getAgent(input.parentAgentId)
      : null;
    const lineageRootId = parent?.lineageRootId ?? id;
    const record: AgentRecord = {
      id,
      slug,
      name: input.name,
      parentAgentId: parent?.id ?? null,
      lineageRootId,
      createdAt: nowIso(),
      metadata: input.metadata ?? {},
    };
    this.db
      .prepare(
        `INSERT INTO agents (id, slug, name, parent_agent_id, lineage_root_id, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.slug,
        record.name,
        sqlVal(record.parentAgentId),
        record.lineageRootId,
        record.createdAt,
        JSON.stringify(record.metadata),
      );
    if (parent) {
      this.addLineageEdge({
        parentAgentId: parent.id,
        childAgentId: record.id,
        reason: "clone",
      });
    }
    return record;
  }

  cloneAgent(agentId: string, opts: { name?: string; reason: string }): {
    agent: AgentRecord;
    edge: LineageEdge;
  } {
    const parent = this.requireAgent(agentId);
    const agent = this.createAgent({
      name: opts.name ?? `${parent.name}-clone`,
      parentAgentId: parent.id,
      metadata: { ...parent.metadata, clonedFrom: parent.id },
    });
    // createAgent already inserted a lineage edge with reason "clone"; update it.
    const edge = this.listLineage(agent.id).at(-1)!;
    this.db
      .prepare("UPDATE lineage SET reason = ? WHERE id = ?")
      .run(opts.reason, edge.id);
    return {
      agent,
      edge: { ...edge, reason: opts.reason },
    };
  }

  deleteAgent(idOrSlug: string): boolean {
    const agent = this.getAgent(idOrSlug);
    if (!agent) return false;
    const conversations = this.listConversations(agent.id);
    for (const conversation of conversations) {
      this.deleteConversation(conversation.id);
    }
    this.db.prepare("DELETE FROM memories WHERE agent_id = ?").run(agent.id);
    this.db.prepare("DELETE FROM lineage WHERE parent_agent_id = ? OR child_agent_id = ?").run(agent.id, agent.id);
    this.db.prepare("DELETE FROM experiments WHERE agent_id = ?").run(agent.id);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);
    return true;
  }

  // --- Conversations ---------------------------------------------------------

  listConversations(agentId: string): ConversationRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM conversations WHERE agent_id = ? ORDER BY created_at ASC",
      )
      .all(agentId) as Array<Record<string, unknown>>;
    return rows.map(mapConversation);
  }

  getConversation(idOrSlug: string, agentId?: string): ConversationRecord | null {
    const row = agentId
      ? (this.db
          .prepare(
            "SELECT * FROM conversations WHERE (id = ? OR slug = ?) AND agent_id = ?",
          )
          .get(idOrSlug, idOrSlug, agentId) as Record<string, unknown> | undefined)
      : (this.db
          .prepare("SELECT * FROM conversations WHERE id = ? OR slug = ?")
          .get(idOrSlug, idOrSlug) as Record<string, unknown> | undefined);
    return row ? mapConversation(row) : null;
  }

  createConversation(input: {
    agentId: string;
    name: string;
    slug?: string;
    metadata?: JsonObject;
  }): ConversationRecord {
    this.requireAgent(input.agentId);
    const id = uuidv7();
    const slug = uniqueScopedSlug(
      this,
      input.agentId,
      input.slug ?? slugify(input.name),
    );
    const record: ConversationRecord = {
      id,
      agentId: input.agentId,
      slug,
      name: input.name,
      parentConversationId: null,
      forkedFromEventId: null,
      latestEventId: null,
      createdAt: nowIso(),
      metadata: input.metadata ?? {},
    };
    this.db
      .prepare(
        `INSERT INTO conversations
         (id, agent_id, slug, name, parent_conversation_id, forked_from_event_id, latest_event_id, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.agentId,
        record.slug,
        record.name,
        null,
        null,
        null,
        record.createdAt,
        JSON.stringify(record.metadata),
      );
    return record;
  }

  forkConversation(
    conversationId: string,
    opts: { name?: string; fromEventId?: string | null } = {},
  ): ConversationRecord {
    const source = this.requireConversation(conversationId);
    const forkPoint = opts.fromEventId ?? source.latestEventId ?? null;
    const id = uuidv7();
    const name = opts.name ?? `${source.name}-fork`;
    const slug = uniqueScopedSlug(this, source.agentId, slugify(name));
    const record: ConversationRecord = {
      id,
      agentId: source.agentId,
      slug,
      name,
      parentConversationId: source.id,
      forkedFromEventId: forkPoint,
      latestEventId: null,
      createdAt: nowIso(),
      metadata: { forkedFrom: source.id },
    };
    this.db
      .prepare(
        `INSERT INTO conversations
         (id, agent_id, slug, name, parent_conversation_id, forked_from_event_id, latest_event_id, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.agentId,
        record.slug,
        record.name,
        sqlVal(record.parentConversationId),
        sqlVal(record.forkedFromEventId),
        null,
        record.createdAt,
        JSON.stringify(record.metadata),
      );

    const events = this.getEvents(source.id, {
      direction: "asc",
      limit: 100_000,
    }).events;
    const copied = forkPoint
      ? events.filter((event) => event.id <= forkPoint)
      : events;
    for (const event of copied) {
      this.appendEvent({
        conversationId: record.id,
        sessionId: event.sessionId,
        turnId: event.turnId,
        type: event.type,
        data: {
          ...event.data,
          _forkedFromEventId: event.id,
        },
      });
    }
    this.appendEvent({
      conversationId: record.id,
      type: "conversation_forked",
      data: {
        parentConversationId: source.id,
        fromEventId: forkPoint,
      },
    });
    return this.requireConversation(record.id);
  }

  deleteConversation(idOrSlug: string): boolean {
    const conversation = this.getConversation(idOrSlug);
    if (!conversation) return false;
    this.db
      .prepare("DELETE FROM events WHERE conversation_id = ?")
      .run(conversation.id);
    this.db
      .prepare("DELETE FROM turns WHERE conversation_id = ?")
      .run(conversation.id);
    this.db
      .prepare("DELETE FROM sessions WHERE conversation_id = ?")
      .run(conversation.id);
    this.db
      .prepare("DELETE FROM sandboxes WHERE conversation_id = ?")
      .run(conversation.id);
    this.db
      .prepare("DELETE FROM experiments WHERE conversation_id = ?")
      .run(conversation.id);
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversation.id);
    return true;
  }

  // --- Sessions / turns / events ---------------------------------------------

  startSession(conversationId: string): SessionRecord {
    this.requireConversation(conversationId);
    const record: SessionRecord = {
      id: uuidv7(),
      conversationId,
      startedAt: nowIso(),
      endedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, conversation_id, started_at, ended_at) VALUES (?, ?, ?, ?)`,
      )
      .run(record.id, record.conversationId, record.startedAt, null);
    this.appendEvent({
      conversationId,
      sessionId: record.id,
      type: "session_started",
      data: {},
    });
    return record;
  }

  endSession(sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (session.endedAt) return;
    const endedAt = nowIso();
    this.db
      .prepare("UPDATE sessions SET ended_at = ? WHERE id = ?")
      .run(endedAt, sessionId);
    this.appendEvent({
      conversationId: session.conversationId,
      sessionId,
      type: "session_ended",
      data: {},
    });
  }

  beginTurn(input: {
    conversationId: string;
    sessionId?: string | null;
    userMessage?: string | null;
  }): { turn: TurnRecord; session: SessionRecord; events: EventRecord[] } {
    const conversation = this.requireConversation(input.conversationId);
    const session = input.sessionId
      ? this.requireSession(input.sessionId)
      : this.startSession(conversation.id);
    const turn: TurnRecord = {
      id: uuidv7(),
      conversationId: conversation.id,
      sessionId: session.id,
      startedAt: nowIso(),
      endedAt: null,
      finishEventId: null,
    };
    this.db
      .prepare(
        `INSERT INTO turns (id, conversation_id, session_id, started_at, ended_at, finish_event_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(turn.id, turn.conversationId, turn.sessionId, turn.startedAt, null, null);

    const events: EventRecord[] = [];
    events.push(
      this.appendEvent({
        conversationId: conversation.id,
        sessionId: session.id,
        turnId: turn.id,
        type: "turn_started",
        data: {},
      }),
    );
    if (input.userMessage) {
      events.push(
        this.appendEvent({
          conversationId: conversation.id,
          sessionId: session.id,
          turnId: turn.id,
          type: "messages",
          data: {
            messages: [{ role: "user", content: input.userMessage }],
          },
        }),
      );
    }
    return { turn, session, events };
  }

  finishTurn(turnId: string): EventRecord {
    const turn = this.requireTurn(turnId);
    if (turn.finishEventId) {
      return this.requireEvent(turn.finishEventId);
    }
    const event = this.appendEvent({
      conversationId: turn.conversationId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      type: "turn_ended",
      data: {},
    });
    this.db
      .prepare(
        "UPDATE turns SET ended_at = ?, finish_event_id = ? WHERE id = ?",
      )
      .run(nowIso(), event.id, turn.id);
    return event;
  }

  appendEvent(input: {
    conversationId: string;
    sessionId?: string | null;
    turnId?: string | null;
    type: EventType;
    data: JsonObject;
  }): EventRecord {
    this.requireConversation(input.conversationId);
    const event: EventRecord = {
      id: uuidv7(),
      conversationId: input.conversationId,
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
      type: input.type,
      createdAt: nowIso(),
      data: input.data,
    };
    this.db
      .prepare(
        `INSERT INTO events (id, conversation_id, session_id, turn_id, type, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.conversationId,
        sqlVal(event.sessionId),
        sqlVal(event.turnId),
        event.type,
        event.createdAt,
        JSON.stringify(event.data),
      );
    this.db
      .prepare("UPDATE conversations SET latest_event_id = ? WHERE id = ?")
      .run(event.id, event.conversationId);
    return event;
  }

  getEvents(conversationId: string, query: EventQuery = {}): GetEventsResult {
    const direction = query.direction ?? "asc";
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 10_000);
    const params: unknown[] = [conversationId];
    let sql = "SELECT * FROM events WHERE conversation_id = ?";
    if (query.cursor) {
      sql += direction === "asc" ? " AND id > ?" : " AND id < ?";
      params.push(query.cursor);
    }
    if (query.sessionId) {
      sql += " AND session_id = ?";
      params.push(query.sessionId);
    }
    if (query.turnId) {
      sql += " AND turn_id = ?";
      params.push(query.turnId);
    }
    if (query.types?.length) {
      sql += ` AND type IN (${query.types.map(() => "?").join(",")})`;
      params.push(...query.types.map((t) => sqlVal(t)));
    }
    sql += ` ORDER BY id ${direction.toUpperCase()} LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...(params.map((p) => sqlVal(p as never)) as never[])) as Array<
      Record<string, unknown>
    >;
    const events = rows.map(mapEvent);
    return {
      events,
      nextCursor: events.at(-1)?.id ?? null,
    };
  }

  getEvent(eventId: string): EventRecord | null {
    const row = this.db
      .prepare("SELECT * FROM events WHERE id = ?")
      .get(eventId) as Record<string, unknown> | undefined;
    return row ? mapEvent(row) : null;
  }

  // --- Artifacts -------------------------------------------------------------

  writeArtifact(input: {
    path: string;
    bytes: Buffer | string;
    agentId?: string | null;
    conversationId?: string | null;
  }): ArtifactVersion {
    const bytes = Buffer.isBuffer(input.bytes)
      ? input.bytes
      : Buffer.from(input.bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const latest = this.getArtifact(input.path, {
      agentId: input.agentId,
      conversationId: input.conversationId,
    });
    const version = (latest?.version ?? 0) + 1;
    const id = uuidv7();
    const createdAt = nowIso();
    const storagePath = join(
      this.paths.artifactsDir,
      input.agentId ?? "_global",
      input.conversationId ?? "_none",
      `${sha256}.bin`,
    );
    mkdirSync(dirname(storagePath), { recursive: true });
    if (!existsSync(storagePath)) {
      writeFileSync(storagePath, bytes);
    }
    this.db
      .prepare(
        `INSERT INTO artifacts
         (id, agent_id, conversation_id, path, version, created_at, size_bytes, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentId ?? null,
        input.conversationId ?? null,
        input.path,
        version,
        createdAt,
        bytes.byteLength,
        sha256,
      );
    const record: ArtifactVersion = {
      id,
      agentId: input.agentId ?? null,
      conversationId: input.conversationId ?? null,
      path: input.path,
      version,
      createdAt,
      sizeBytes: bytes.byteLength,
      sha256,
    };
    if (input.conversationId) {
      this.appendEvent({
        conversationId: input.conversationId,
        type: "artifact_written",
        data: {
          artifactId: id,
          path: input.path,
          version,
          sha256,
          sizeBytes: bytes.byteLength,
        },
      });
    }
    return record;
  }

  getArtifact(
    path: string,
    scope: { agentId?: string | null; conversationId?: string | null } = {},
  ): ArtifactVersion | null {
    const row = this.db
      .prepare(
        `SELECT * FROM artifacts
         WHERE path = ?
           AND ((? IS NULL AND agent_id IS NULL) OR agent_id = ?)
           AND ((? IS NULL AND conversation_id IS NULL) OR conversation_id = ?)
         ORDER BY version DESC LIMIT 1`,
      )
      .get(
        path,
        scope.agentId ?? null,
        scope.agentId ?? null,
        scope.conversationId ?? null,
        scope.conversationId ?? null,
      ) as Record<string, unknown> | undefined;
    return row ? mapArtifact(row) : null;
  }

  readArtifactBytes(artifact: ArtifactVersion): Buffer {
    const storagePath = join(
      this.paths.artifactsDir,
      artifact.agentId ?? "_global",
      artifact.conversationId ?? "_none",
      `${artifact.sha256}.bin`,
    );
    return readFileSync(storagePath);
  }

  // --- Secrets ---------------------------------------------------------------

  putSecret(input: {
    name: string;
    kind?: "key" | "oauth";
    value: JsonObject;
    scope?: "global" | "agent" | "conversation";
    scopeId?: string | null;
  }): SecretMetadata {
    const scope = input.scope ?? "global";
    const existing = this.db
      .prepare(
        `SELECT id FROM secrets WHERE scope = ? AND IFNULL(scope_id, '') = IFNULL(?, '') AND name = ?`,
      )
      .get(scope, input.scopeId ?? null, input.name) as
      | { id: string }
      | undefined;
    const id = existing?.id ?? uuidv7();
    const createdAt = nowIso();
    if (existing) {
      this.db
        .prepare("UPDATE secrets SET kind = ?, value = ? WHERE id = ?")
        .run(input.kind ?? "key", JSON.stringify(input.value), id);
    } else {
      this.db
        .prepare(
          `INSERT INTO secrets (id, scope, scope_id, name, kind, created_at, value)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          scope,
          input.scopeId ?? null,
          input.name,
          input.kind ?? "key",
          createdAt,
          JSON.stringify(input.value),
        );
    }
    return {
      id,
      scope,
      scopeId: input.scopeId ?? null,
      name: input.name,
      kind: input.kind ?? "key",
      createdAt,
    };
  }

  getSecret(
    name: string,
    scopes: Array<{ scope: "global" | "agent" | "conversation"; scopeId?: string | null }> = [
      { scope: "global" },
    ],
  ): SecretRecord | null {
    for (const scope of [...scopes].reverse()) {
      const row = this.db
        .prepare(
          `SELECT * FROM secrets
           WHERE scope = ? AND IFNULL(scope_id, '') = IFNULL(?, '') AND name = ?`,
        )
        .get(scope.scope, scope.scopeId ?? null, name) as
        | Record<string, unknown>
        | undefined;
      if (row) return mapSecret(row);
    }
    return null;
  }

  listSecrets(
    scope?: "global" | "agent" | "conversation",
    scopeId?: string | null,
  ): SecretMetadata[] {
    const rows = (
      scope
        ? this.db
            .prepare(
              `SELECT id, scope, scope_id, name, kind, created_at FROM secrets
               WHERE scope = ? AND IFNULL(scope_id, '') = IFNULL(?, '')
               ORDER BY name`,
            )
            .all(scope, scopeId ?? null)
        : this.db
            .prepare(
              `SELECT id, scope, scope_id, name, kind, created_at FROM secrets ORDER BY scope, name`,
            )
            .all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      scope: row.scope as SecretMetadata["scope"],
      scopeId: (row.scope_id as string | null) ?? null,
      name: String(row.name),
      kind: row.kind as SecretMetadata["kind"],
      createdAt: String(row.created_at),
    }));
  }

  // --- Memory ----------------------------------------------------------------

  remember(agentId: string, key: string, content: string): MemoryEntry {
    this.requireAgent(agentId);
    const existing = this.db
      .prepare("SELECT * FROM memories WHERE agent_id = ? AND key = ?")
      .get(agentId, key) as Record<string, unknown> | undefined;
    const now = nowIso();
    if (existing) {
      this.db
        .prepare(
          "UPDATE memories SET content = ?, updated_at = ? WHERE id = ?",
        )
        .run(content, now, String(existing.id));
      return {
        id: String(existing.id),
        agentId,
        key,
        content,
        createdAt: String(existing.created_at),
        updatedAt: now,
      };
    }
    const entry: MemoryEntry = {
      id: uuidv7(),
      agentId,
      key,
      content,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO memories (id, agent_id, key, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.agentId,
        entry.key,
        entry.content,
        entry.createdAt,
        entry.updatedAt,
      );
    return entry;
  }

  forget(agentId: string, key: string): boolean {
    const result = this.db
      .prepare("DELETE FROM memories WHERE agent_id = ? AND key = ?")
      .run(agentId, key);
    return Number(result.changes) > 0;
  }

  listMemories(agentId: string): MemoryEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE agent_id = ? ORDER BY updated_at DESC",
      )
      .all(agentId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      agentId: String(row.agent_id),
      key: String(row.key),
      content: String(row.content),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  // --- Sandboxes -------------------------------------------------------------

  createSandbox(input: {
    conversationId: string;
    provider?: "local" | "docker";
    metadata?: JsonObject;
  }): SandboxRecord {
    this.requireConversation(input.conversationId);
    const id = uuidv7();
    const workDir = join(this.paths.sandboxesDir, id);
    mkdirSync(workDir, { recursive: true });
    const record: SandboxRecord = {
      id,
      conversationId: input.conversationId,
      provider: input.provider ?? "local",
      status: "created",
      workDir,
      createdAt: nowIso(),
      metadata: input.metadata ?? {},
    };
    this.db
      .prepare(
        `INSERT INTO sandboxes
         (id, conversation_id, provider, status, work_dir, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.conversationId,
        record.provider,
        record.status,
        record.workDir,
        record.createdAt,
        JSON.stringify(record.metadata),
      );
    this.appendEvent({
      conversationId: input.conversationId,
      type: "sandbox_created",
      data: { sandboxId: id, provider: record.provider, workDir },
    });
    return record;
  }

  startSandbox(sandboxId: string): SandboxRecord {
    const sandbox = this.requireSandbox(sandboxId);
    this.db
      .prepare("UPDATE sandboxes SET status = ? WHERE id = ?")
      .run("running", sandboxId);
    this.appendEvent({
      conversationId: sandbox.conversationId,
      type: "sandbox_started",
      data: { sandboxId },
    });
    return this.requireSandbox(sandboxId);
  }

  stopSandbox(sandboxId: string): SandboxRecord {
    const sandbox = this.requireSandbox(sandboxId);
    this.db
      .prepare("UPDATE sandboxes SET status = ? WHERE id = ?")
      .run("stopped", sandboxId);
    this.appendEvent({
      conversationId: sandbox.conversationId,
      type: "sandbox_stopped",
      data: { sandboxId },
    });
    return this.requireSandbox(sandboxId);
  }

  snapshotSandbox(sandboxId: string, note?: string): SnapshotRecord {
    const sandbox = this.requireSandbox(sandboxId);
    const id = uuidv7();
    const path = join(this.paths.snapshotsDir, `${id}.tgz`);
    // Local snapshot: copy workdir tree as a simple marker + file dump index.
    // Full tar is optional; we store a manifest for restore.
    const manifest = {
      sandboxId,
      note: note ?? null,
      createdAt: nowIso(),
      files: listFilesRecursive(sandbox.workDir, sandbox.workDir),
    };
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    const record: SnapshotRecord = {
      id,
      sandboxId,
      createdAt: manifest.createdAt,
      note: note ?? null,
      path,
    };
    this.db
      .prepare(
        `INSERT INTO snapshots (id, sandbox_id, created_at, note, path)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.sandboxId, record.createdAt, sqlVal(record.note), record.path);
    this.appendEvent({
      conversationId: sandbox.conversationId,
      type: "sandbox_snapshotted",
      data: { sandboxId, snapshotId: id, note: note ?? null },
    });
    return record;
  }

  rewindSandbox(sandboxId: string, snapshotId: string): SandboxRecord {
    const sandbox = this.requireSandbox(sandboxId);
    const snapshot = this.requireSnapshot(snapshotId);
    if (snapshot.sandboxId !== sandboxId) {
      throw new Error("Snapshot does not belong to this sandbox");
    }
    const manifest = parseJson<{
      files: Array<{ relativePath: string; contentBase64: string }>;
    }>(readFileSync(snapshot.path, "utf8"));
    rmSync(sandbox.workDir, { recursive: true, force: true });
    mkdirSync(sandbox.workDir, { recursive: true });
    for (const file of manifest.files) {
      const target = join(sandbox.workDir, file.relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(file.contentBase64, "base64"));
    }
    return sandbox;
  }

  listSnapshots(sandboxId: string): SnapshotRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM snapshots WHERE sandbox_id = ? ORDER BY created_at ASC",
      )
      .all(sandboxId) as Array<Record<string, unknown>>;
    return rows.map(mapSnapshot);
  }

  getSandbox(sandboxId: string): SandboxRecord | null {
    const row = this.db
      .prepare("SELECT * FROM sandboxes WHERE id = ?")
      .get(sandboxId) as Record<string, unknown> | undefined;
    return row ? mapSandbox(row) : null;
  }

  listSandboxes(conversationId: string): SandboxRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM sandboxes WHERE conversation_id = ? ORDER BY created_at ASC",
      )
      .all(conversationId) as Array<Record<string, unknown>>;
    return rows.map(mapSandbox);
  }

  // --- Lineage / experiments -------------------------------------------------

  addLineageEdge(input: {
    parentAgentId: string;
    childAgentId: string;
    reason: string;
    eventId?: string | null;
  }): LineageEdge {
    const edge: LineageEdge = {
      id: uuidv7(),
      parentAgentId: input.parentAgentId,
      childAgentId: input.childAgentId,
      reason: input.reason,
      createdAt: nowIso(),
      eventId: input.eventId ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO lineage (id, parent_agent_id, child_agent_id, reason, created_at, event_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        edge.id,
        edge.parentAgentId,
        edge.childAgentId,
        edge.reason,
        edge.createdAt,
        sqlVal(edge.eventId),
      );
    return edge;
  }

  listLineage(agentId: string): LineageEdge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM lineage
         WHERE parent_agent_id = ? OR child_agent_id = ?
         ORDER BY created_at ASC`,
      )
      .all(agentId, agentId) as Array<Record<string, unknown>>;
    return rows.map(mapLineage);
  }

  openExperiment(input: {
    agentId: string;
    conversationId: string;
    title: string;
    hypothesis: string;
  }): ExperimentRecord {
    const record: ExperimentRecord = {
      id: uuidv7(),
      agentId: input.agentId,
      conversationId: input.conversationId,
      title: input.title,
      hypothesis: input.hypothesis,
      status: "open",
      createdAt: nowIso(),
      closedAt: null,
      result: null,
    };
    this.db
      .prepare(
        `INSERT INTO experiments
         (id, agent_id, conversation_id, title, hypothesis, status, created_at, closed_at, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.agentId,
        record.conversationId,
        record.title,
        record.hypothesis,
        record.status,
        record.createdAt,
        null,
        null,
      );
    this.appendEvent({
      conversationId: input.conversationId,
      type: "experiment_opened",
      data: {
        experimentId: record.id,
        title: record.title,
        hypothesis: record.hypothesis,
      },
    });
    return record;
  }

  closeExperiment(
    experimentId: string,
    status: "promoted" | "abandoned",
    result?: string,
  ): ExperimentRecord {
    const existing = this.requireExperiment(experimentId);
    const closedAt = nowIso();
    this.db
      .prepare(
        "UPDATE experiments SET status = ?, closed_at = ?, result = ? WHERE id = ?",
      )
      .run(status, closedAt, result ?? null, experimentId);
    this.appendEvent({
      conversationId: existing.conversationId,
      type: "experiment_closed",
      data: {
        experimentId,
        status,
        result: result ?? null,
      },
    });
    return this.requireExperiment(experimentId);
  }

  listExperiments(agentId: string): ExperimentRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM experiments WHERE agent_id = ? ORDER BY created_at ASC",
      )
      .all(agentId) as Array<Record<string, unknown>>;
    return rows.map(mapExperiment);
  }

  // --- Reset -----------------------------------------------------------------

  wipeAll(): void {
    this.db.exec(`
      DELETE FROM events;
      DELETE FROM turns;
      DELETE FROM sessions;
      DELETE FROM conversations;
      DELETE FROM agents;
      DELETE FROM artifacts;
      DELETE FROM secrets;
      DELETE FROM memories;
      DELETE FROM sandboxes;
      DELETE FROM snapshots;
      DELETE FROM lineage;
      DELETE FROM experiments;
    `);
    rmSync(this.paths.artifactsDir, { recursive: true, force: true });
    rmSync(this.paths.sandboxesDir, { recursive: true, force: true });
    rmSync(this.paths.snapshotsDir, { recursive: true, force: true });
    mkdirSync(this.paths.artifactsDir, { recursive: true });
    mkdirSync(this.paths.sandboxesDir, { recursive: true });
    mkdirSync(this.paths.snapshotsDir, { recursive: true });
  }

  // --- Helpers ---------------------------------------------------------------

  private ensureMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  requireAgent(idOrSlug: string): AgentRecord {
    const agent = this.getAgent(idOrSlug);
    if (!agent) throw new Error(`Unknown agent: ${idOrSlug}`);
    return agent;
  }

  requireConversation(idOrSlug: string): ConversationRecord {
    const conversation = this.getConversation(idOrSlug);
    if (!conversation) throw new Error(`Unknown conversation: ${idOrSlug}`);
    return conversation;
  }

  private requireSession(sessionId: string): SessionRecord {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown session: ${sessionId}`);
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      startedAt: String(row.started_at),
      endedAt: (row.ended_at as string | null) ?? null,
    };
  }

  private requireTurn(turnId: string): TurnRecord {
    const row = this.db
      .prepare("SELECT * FROM turns WHERE id = ?")
      .get(turnId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown turn: ${turnId}`);
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      sessionId: String(row.session_id),
      startedAt: String(row.started_at),
      endedAt: (row.ended_at as string | null) ?? null,
      finishEventId: (row.finish_event_id as string | null) ?? null,
    };
  }

  private requireEvent(eventId: string): EventRecord {
    const event = this.getEvent(eventId);
    if (!event) throw new Error(`Unknown event: ${eventId}`);
    return event;
  }

  private requireSandbox(sandboxId: string): SandboxRecord {
    const sandbox = this.getSandbox(sandboxId);
    if (!sandbox) throw new Error(`Unknown sandbox: ${sandboxId}`);
    return sandbox;
  }

  private requireSnapshot(snapshotId: string): SnapshotRecord {
    const row = this.db
      .prepare("SELECT * FROM snapshots WHERE id = ?")
      .get(snapshotId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown snapshot: ${snapshotId}`);
    return mapSnapshot(row);
  }

  private requireExperiment(experimentId: string): ExperimentRecord {
    const row = this.db
      .prepare("SELECT * FROM experiments WHERE id = ?")
      .get(experimentId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown experiment: ${experimentId}`);
    return mapExperiment(row);
  }
}

function uniqueSlug(kernel: HelixKernel, _table: "agents", base: string): string {
  let candidate = base;
  let i = 2;
  while (kernel.getAgent(candidate)) {
    candidate = `${base}-${i++}`;
  }
  return candidate;
}

function uniqueScopedSlug(
  kernel: HelixKernel,
  agentId: string,
  base: string,
): string {
  let candidate = base;
  let i = 2;
  while (kernel.getConversation(candidate, agentId)) {
    candidate = `${base}-${i++}`;
  }
  return candidate;
}

function mapAgent(row: Record<string, unknown>): AgentRecord {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    parentAgentId: (row.parent_agent_id as string | null) ?? null,
    lineageRootId: String(row.lineage_root_id),
    createdAt: String(row.created_at),
    metadata: parseJson(String(row.metadata)),
  };
}

function mapConversation(row: Record<string, unknown>): ConversationRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    slug: String(row.slug),
    name: String(row.name),
    parentConversationId: (row.parent_conversation_id as string | null) ?? null,
    forkedFromEventId: (row.forked_from_event_id as string | null) ?? null,
    latestEventId: (row.latest_event_id as string | null) ?? null,
    createdAt: String(row.created_at),
    metadata: parseJson(String(row.metadata)),
  };
}

function mapEvent(row: Record<string, unknown>): EventRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    sessionId: (row.session_id as string | null) ?? null,
    turnId: (row.turn_id as string | null) ?? null,
    type: row.type as EventType,
    createdAt: String(row.created_at),
    data: parseJson(String(row.data)),
  };
}

function mapArtifact(row: Record<string, unknown>): ArtifactVersion {
  return {
    id: String(row.id),
    agentId: (row.agent_id as string | null) ?? null,
    conversationId: (row.conversation_id as string | null) ?? null,
    path: String(row.path),
    version: Number(row.version),
    createdAt: String(row.created_at),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
  };
}

function mapSecret(row: Record<string, unknown>): SecretRecord {
  return {
    id: String(row.id),
    scope: row.scope as SecretRecord["scope"],
    scopeId: (row.scope_id as string | null) ?? null,
    name: String(row.name),
    kind: row.kind as SecretRecord["kind"],
    createdAt: String(row.created_at),
    value: parseJson(String(row.value)),
  };
}

function mapSandbox(row: Record<string, unknown>): SandboxRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    provider: row.provider as SandboxRecord["provider"],
    status: row.status as SandboxRecord["status"],
    workDir: String(row.work_dir),
    createdAt: String(row.created_at),
    metadata: parseJson(String(row.metadata)),
  };
}

function mapSnapshot(row: Record<string, unknown>): SnapshotRecord {
  return {
    id: String(row.id),
    sandboxId: String(row.sandbox_id),
    createdAt: String(row.created_at),
    note: (row.note as string | null) ?? null,
    path: String(row.path),
  };
}

function mapLineage(row: Record<string, unknown>): LineageEdge {
  return {
    id: String(row.id),
    parentAgentId: String(row.parent_agent_id),
    childAgentId: String(row.child_agent_id),
    reason: String(row.reason),
    createdAt: String(row.created_at),
    eventId: (row.event_id as string | null) ?? null,
  };
}

function mapExperiment(row: Record<string, unknown>): ExperimentRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    conversationId: String(row.conversation_id),
    title: String(row.title),
    hypothesis: String(row.hypothesis),
    status: row.status as ExperimentRecord["status"],
    createdAt: String(row.created_at),
    closedAt: (row.closed_at as string | null) ?? null,
    result: (row.result as string | null) ?? null,
  };
}

function listFilesRecursive(
  root: string,
  current: string,
): Array<{ relativePath: string; contentBase64: string }> {
  const out: Array<{ relativePath: string; contentBase64: string }> = [];
  if (!existsSync(current)) return out;
  for (const entry of readdirSync(current)) {
    const full = join(current, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(root, full));
    } else if (st.isFile()) {
      out.push({
        relativePath: relative(root, full),
        contentBase64: readFileSync(full).toString("base64"),
      });
    }
  }
  return out;
}

export function migrateHomeIfNeeded(home: string): string {
  const paths = resolveKernelPaths(home);
  mkdirSync(paths.home, { recursive: true });
  return paths.home;
}

/** Atomic JSON write helper used by adapters and tools. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}
