/**
 * Persistência de threads e histórico de mensagens no PostgreSQL local.
 *
 * Substitui a camada de threads duráveis do CopilotKit Intelligence. Cada
 * thread é uma linha em `noma_threads`; cada mensagem é uma linha em
 * `noma_messages`. O lock de execução é implementado via UPDATE atômico na
 * coluna `locked_by_run_id` com TTL.
 */

import { randomUUID } from "node:crypto";
import type {
  AcquireThreadLockParams,
  AcquireThreadLockResult,
  CleanupThreadLockParams,
  GetOrCreateThreadParams,
  GetOrCreateThreadResult,
  GetThreadMessagesParams,
  GetThreadMessagesResult,
  GetThreadParams,
  GetThreadResult,
  RecordRunStopParams,
  RenewThreadLockParams,
  ThreadMessage,
} from "./types";
import { PlatformRequestError } from "./errors";

// ---------------------------------------------------------------------------
// Contrato de banco de dados (injectável para testes)
// ---------------------------------------------------------------------------

export type ThreadRow = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  learning_container_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type MessageRow = {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  created_at: Date;
  metadata: string | null;
};

export type LockRow = {
  thread_id: string;
  run_id: string;
  user_id: string;
  expires_at: Date;
  retryable: boolean;
};

/** Contrato mínimo de banco que o store precisa. */
export interface ThreadDatabase {
  queryThread(threadId: string): Promise<ThreadRow | undefined>;
  insertThread(row: Omit<ThreadRow, "created_at" | "updated_at">): Promise<ThreadRow>;
  queryMessages(threadId: string): Promise<MessageRow[]>;
  insertMessages(rows: Omit<MessageRow, "created_at">[]): Promise<void>;
  /**
   * Tenta adquirir o lock. Retorna o lock se adquirido, ou null se já existe
   * um lock ativo de outro run (conflito — 409).
   */
  tryAcquireLock(
    threadId: string,
    runId: string,
    userId: string,
    ttlSeconds: number,
  ): Promise<LockRow | null>;
  renewLock(threadId: string, runId: string, ttlSeconds: number): Promise<void>;
  releaseLock(threadId: string, runId: string): Promise<void>;
  recordRunStop(
    threadId: string,
    runId: string,
    userId: string,
    agentId: string,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementação PostgreSQL com postgres.js
// ---------------------------------------------------------------------------

export function createPostgresThreadDatabase(sql: {
  // Assinatura mínima compatível com postgres.js tagged-template queries
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
}): ThreadDatabase {
  return {
    async queryThread(threadId) {
      const rows = await sql<ThreadRow[]>`
        SELECT id, owner_user_id, agent_id, learning_container_id, created_at, updated_at
        FROM noma_threads
        WHERE id = ${threadId}
        LIMIT 1
      `;
      return rows[0];
    },

    async insertThread(row) {
      const [inserted] = await sql<ThreadRow[]>`
        INSERT INTO noma_threads (id, owner_user_id, agent_id, learning_container_id)
        VALUES (${row.id}, ${row.owner_user_id}, ${row.agent_id}, ${row.learning_container_id})
        ON CONFLICT (id) DO UPDATE
          SET updated_at = now()
        RETURNING *
      `;
      if (!inserted) throw new Error("Thread insert returned no row.");
      return inserted;
    },

    async queryMessages(threadId) {
      return sql<MessageRow[]>`
        SELECT id, thread_id, role, content, created_at, metadata
        FROM noma_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC
      `;
    },

    async insertMessages(rows) {
      if (!rows.length) return;
      for (const row of rows) {
        await sql`
          INSERT INTO noma_messages (id, thread_id, role, content, metadata)
          VALUES (${row.id}, ${row.thread_id}, ${row.role}, ${row.content}, ${row.metadata})
          ON CONFLICT (id) DO NOTHING
        `;
      }
    },

    async tryAcquireLock(threadId, runId, userId, ttlSeconds) {
      // Remove locks expirados do mesmo thread antes de tentar.
      await sql`
        DELETE FROM noma_thread_locks
        WHERE thread_id = ${threadId}
          AND expires_at < now()
      `;
      // Tenta inserir; se já houver um lock ativo, o INSERT falha no unique.
      const rows = await sql<LockRow[]>`
        INSERT INTO noma_thread_locks (thread_id, run_id, user_id, expires_at, retryable)
        VALUES (
          ${threadId},
          ${runId},
          ${userId},
          now() + (${ttlSeconds} * interval '1 second'),
          true
        )
        ON CONFLICT (thread_id) DO NOTHING
        RETURNING *
      `;
      return rows[0] ?? null;
    },

    async renewLock(threadId, runId, ttlSeconds) {
      await sql`
        UPDATE noma_thread_locks
        SET expires_at = now() + (${ttlSeconds} * interval '1 second')
        WHERE thread_id = ${threadId}
          AND run_id = ${runId}
      `;
    },

    async releaseLock(threadId, runId) {
      await sql`
        DELETE FROM noma_thread_locks
        WHERE thread_id = ${threadId}
          AND run_id = ${runId}
      `;
    },

    async recordRunStop(threadId, runId, userId, agentId) {
      await sql`
        INSERT INTO noma_run_stops (id, thread_id, run_id, user_id, agent_id, stopped_at)
        VALUES (${randomUUID()}, ${threadId}, ${runId}, ${userId}, ${agentId}, now())
        ON CONFLICT DO NOTHING
      `;
    },
  };
}

// ---------------------------------------------------------------------------
// Store de threads (lógica de negócio)
// ---------------------------------------------------------------------------

const DEFAULT_LOCK_TTL_SECONDS = 120;

export function createThreadStore(database: ThreadDatabase) {
  return {
    async getOrCreate(
      params: GetOrCreateThreadParams,
    ): Promise<GetOrCreateThreadResult> {
      const existing = await database.queryThread(params.threadId);
      if (existing) {
        return { threadId: params.threadId, isNew: false };
      }
      await database.insertThread({
        id: params.threadId,
        owner_user_id: params.userId,
        agent_id: params.agentId,
        learning_container_id: params.learningContainerId ?? null,
      });
      return { threadId: params.threadId, isNew: true };
    },

    async get(params: GetThreadParams): Promise<GetThreadResult> {
      const row = await database.queryThread(params.threadId);
      if (!row) {
        throw new PlatformRequestError(
          `Thread not found: ${params.threadId}`,
          404,
          false,
        );
      }
      return { threadId: row.id };
    },

    async getMessages(
      params: GetThreadMessagesParams,
    ): Promise<GetThreadMessagesResult> {
      const rows = await database.queryMessages(params.threadId);
      const messages: ThreadMessage[] = rows.map((row) => ({
        id: row.id,
        role: row.role as ThreadMessage["role"],
        content: row.content,
        createdAt: row.created_at.toISOString(),
        ...(row.metadata ? (JSON.parse(row.metadata) as object) : {}),
      }));
      return { messages };
    },

    async acquireLock(
      params: AcquireThreadLockParams,
    ): Promise<AcquireThreadLockResult> {
      const ttl = params.ttlSeconds ?? DEFAULT_LOCK_TTL_SECONDS;
      const lock = await database.tryAcquireLock(
        params.threadId,
        params.runId,
        params.userId,
        ttl,
      );
      if (!lock) {
        // Outro run está ativo — sinaliza conflito retryable (igual ao CopilotKit).
        const error = new PlatformRequestError(
          `Thread ${params.threadId} is already locked by another run.`,
          409,
          true,
        );
        throw error;
      }
      return { runId: params.runId };
    },

    async renewLock(params: RenewThreadLockParams): Promise<void> {
      await database.renewLock(
        params.threadId,
        params.runId,
        params.ttlSeconds ?? DEFAULT_LOCK_TTL_SECONDS,
      );
    },

    async releaseLock(params: CleanupThreadLockParams): Promise<void> {
      await database.releaseLock(params.threadId, params.runId);
    },

    async recordStop(params: RecordRunStopParams): Promise<void> {
      await database.recordRunStop(
        params.threadId,
        params.runId,
        params.userId,
        params.agentId,
      );
    },
  };
}
