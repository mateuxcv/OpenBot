/**
 * Memória semântica local com pgvector.
 *
 * Substitui os métodos de memória do CopilotKit Intelligence:
 *   listMemories / recallMemories / createMemory / updateMemory / removeMemory
 *
 * Estratégia:
 *  - Cada memória é uma linha em `noma_memories` com um embedding gerado pelo
 *    modelo de embedding configurado.
 *  - `recallMemories` faz busca por similaridade coseno via pgvector (<=>).
 *  - Quando nenhum embedding provider é configurado, recall cai para busca
 *    de substring (mesmo comportamento que o OpenBot já tinha localmente).
 *  - `invalidatedAt` não-nulo equivale a "retired" no vocabulário do CopilotKit.
 */

import { randomUUID } from "node:crypto";
import type {
  CreateMemoryParams,
  CreateMemoryResult,
  ListMemoriesParams,
  ListMemoriesResult,
  MemoryItem,
  MemoryScope,
  RecallMemoriesParams,
  RecallMemoriesResult,
  RemoveMemoryParams,
  UpdateMemoryParams,
  UpdateMemoryResult,
} from "./types";

// ---------------------------------------------------------------------------
// Contrato de banco
// ---------------------------------------------------------------------------

export type MemoryRow = {
  id: string;
  user_id: string;
  scope: MemoryScope;
  kind: string;
  content: string;
  embedding: string | null;
  invalidated_at: string | null;
  created_at: Date;
  updated_at: Date;
};

export interface MemoryDatabase {
  listMemories(userId: string, scope: MemoryScope): Promise<MemoryRow[]>;
  searchByEmbedding(
    userId: string,
    scope: MemoryScope,
    embedding: number[],
    limit: number,
  ): Promise<(MemoryRow & { score: number })[]>;
  searchBySubstring(
    userId: string,
    scope: MemoryScope,
    query: string,
    limit: number,
  ): Promise<MemoryRow[]>;
  insertMemory(
    row: Omit<MemoryRow, "created_at" | "updated_at">,
  ): Promise<MemoryRow>;
  invalidateMemory(id: string, userId: string): Promise<MemoryRow | undefined>;
}

// ---------------------------------------------------------------------------
// Implementação PostgreSQL com postgres.js
// ---------------------------------------------------------------------------

export function createPostgresMemoryDatabase(sql: {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
}): MemoryDatabase {
  return {
    async listMemories(userId, scope) {
      return sql<MemoryRow[]>`
        SELECT id, user_id, scope, kind, content, embedding::text, invalidated_at, created_at, updated_at
        FROM noma_memories
        WHERE user_id = ${userId}
          AND scope = ${scope}
          AND invalidated_at IS NULL
        ORDER BY created_at DESC
        LIMIT 200
      `;
    },

    async searchByEmbedding(userId, scope, embedding, limit) {
      // pgvector: <=> é distância coseno; ordenar ASC = mais similares primeiro.
      const vector = `[${embedding.join(",")}]`;
      return sql<(MemoryRow & { score: number })[]>`
        SELECT
          id, user_id, scope, kind, content, embedding::text,
          invalidated_at, created_at, updated_at,
          1 - (embedding <=> ${vector}::vector) AS score
        FROM noma_memories
        WHERE user_id = ${userId}
          AND scope = ${scope}
          AND invalidated_at IS NULL
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vector}::vector
        LIMIT ${limit}
      `;
    },

    async searchBySubstring(userId, scope, query, limit) {
      return sql<MemoryRow[]>`
        SELECT id, user_id, scope, kind, content, embedding::text, invalidated_at, created_at, updated_at
        FROM noma_memories
        WHERE user_id = ${userId}
          AND scope = ${scope}
          AND invalidated_at IS NULL
          AND strpos(lower(content), lower(${query})) > 0
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    },

    async insertMemory(row) {
      const embeddingExpr =
        row.embedding !== null
          ? sql`${row.embedding}::vector`
          : sql`NULL`;

      // postgres.js não permite interpolação dinâmica de expressões em VALUES;
      // usamos dois caminhos separados para evitar casting condicional inline.
      let rows: MemoryRow[];
      if (row.embedding !== null) {
        rows = await sql<MemoryRow[]>`
          INSERT INTO noma_memories (id, user_id, scope, kind, content, embedding)
          VALUES (${row.id}, ${row.user_id}, ${row.scope}, ${row.kind}, ${row.content}, ${row.embedding}::vector)
          RETURNING id, user_id, scope, kind, content, embedding::text, invalidated_at, created_at, updated_at
        `;
      } else {
        rows = await sql<MemoryRow[]>`
          INSERT INTO noma_memories (id, user_id, scope, kind, content)
          VALUES (${row.id}, ${row.user_id}, ${row.scope}, ${row.kind}, ${row.content})
          RETURNING id, user_id, scope, kind, content, embedding::text, invalidated_at, created_at, updated_at
        `;
      }
      if (!rows[0]) throw new Error("Memory insert returned no row.");
      return rows[0];
    },

    async invalidateMemory(id, userId) {
      const rows = await sql<MemoryRow[]>`
        UPDATE noma_memories
        SET invalidated_at = now(), updated_at = now()
        WHERE id = ${id}
          AND user_id = ${userId}
          AND invalidated_at IS NULL
        RETURNING id, user_id, scope, kind, content, embedding::text, invalidated_at, created_at, updated_at
      `;
      return rows[0];
    },
  };
}

// ---------------------------------------------------------------------------
// Contrato do provider de embeddings
// ---------------------------------------------------------------------------

/**
 * Qualquer provider que transforma texto em vetor de floats.
 * Pode ser OpenAI text-embedding-3-small, Ollama nomic-embed-text, etc.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

// ---------------------------------------------------------------------------
// Store de memória
// ---------------------------------------------------------------------------

function toMemoryItem(row: MemoryRow & { score?: number }): MemoryItem {
  return {
    id: row.id,
    content: row.content,
    scope: row.scope as MemoryScope,
    kind: row.kind as MemoryItem["kind"],
    invalidatedAt: row.invalidated_at,
    ...(row.score !== undefined ? { score: row.score } : {}),
  };
}

export function createMemoryStore(options: {
  database: MemoryDatabase;
  embeddings?: EmbeddingProvider;
}) {
  const { database, embeddings } = options;

  return {
    async list(params: ListMemoriesParams): Promise<ListMemoriesResult> {
      const scope = params.memoryGrant.user !== "none" ? "user" : "project";
      const rows = await database.listMemories(params.userId, scope as MemoryScope);
      return { memories: rows.map(toMemoryItem) };
    },

    async recall(params: RecallMemoriesParams): Promise<RecallMemoriesResult> {
      if (embeddings) {
        const vector = await embeddings.embed(params.query);
        const rows = await database.searchByEmbedding(
          params.userId,
          params.scope,
          vector,
          params.limit,
        );
        return { memories: rows.map(toMemoryItem) };
      }
      // Fallback: busca substring quando não há provider de embeddings.
      const rows = await database.searchBySubstring(
        params.userId,
        params.scope,
        params.query,
        params.limit,
      );
      return { memories: rows.map(toMemoryItem) };
    },

    async create(params: CreateMemoryParams): Promise<CreateMemoryResult> {
      let embedding: string | null = null;
      if (embeddings) {
        const vector = await embeddings.embed(params.content);
        embedding = `[${vector.join(",")}]`;
      }
      const row = await database.insertMemory({
        id: randomUUID(),
        user_id: params.userId,
        scope: params.scope,
        kind: params.kind,
        content: params.content,
        embedding,
        invalidated_at: null,
      });
      return { id: row.id };
    },

    async update(params: UpdateMemoryParams): Promise<UpdateMemoryResult> {
      // Intelligence retira o antigo e cria um novo (padrão "supersede").
      await database.invalidateMemory(params.id, params.userId);
      let embedding: string | null = null;
      if (embeddings) {
        const vector = await embeddings.embed(params.content);
        embedding = `[${vector.join(",")}]`;
      }
      const row = await database.insertMemory({
        id: randomUUID(),
        user_id: params.userId,
        scope: params.scope,
        kind: params.kind,
        content: params.content,
        embedding,
        invalidated_at: null,
      });
      return { id: row.id };
    },

    async remove(params: RemoveMemoryParams): Promise<void> {
      await database.invalidateMemory(params.id, params.userId);
    },
  };
}
