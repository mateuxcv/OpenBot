-- Noma Intelligence — migração 0001
-- Cria as tabelas de threads, mensagens, locks, run stops e memórias.
-- Requer a extensão pgvector para busca semântica (memória com embeddings).
-- Se pgvector não estiver disponível, o embedding fica como TEXT e recall
-- usa busca por substring.

-- ---------------------------------------------------------------------------
-- Extensões
-- ---------------------------------------------------------------------------

-- pgvector: instale com `CREATE EXTENSION vector` no PostgreSQL 14+.
-- A coluna de embedding usa TEXT quando a extensão não está disponível;
-- a aplicação detecta e usa busca substring como fallback.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'pgvector não disponível — embeddings desabilitados, recall usará busca substring.';
END;
$$;

-- ---------------------------------------------------------------------------
-- Threads
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS noma_threads (
  id                    TEXT        PRIMARY KEY,
  owner_user_id         TEXT        NOT NULL,
  agent_id              TEXT        NOT NULL,
  learning_container_id TEXT        NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS noma_threads_owner_idx
  ON noma_threads (owner_user_id);

-- ---------------------------------------------------------------------------
-- Mensagens
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS noma_messages (
  id         TEXT        PRIMARY KEY,
  thread_id  TEXT        NOT NULL REFERENCES noma_threads (id) ON DELETE CASCADE,
  role       TEXT        NOT NULL,
  content    TEXT        NOT NULL,
  metadata   TEXT        NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS noma_messages_thread_idx
  ON noma_messages (thread_id, created_at ASC);

-- ---------------------------------------------------------------------------
-- Locks de execução
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS noma_thread_locks (
  thread_id  TEXT        PRIMARY KEY REFERENCES noma_threads (id) ON DELETE CASCADE,
  run_id     TEXT        NOT NULL,
  user_id    TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  retryable  BOOLEAN     NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS noma_thread_locks_expires_idx
  ON noma_thread_locks (expires_at);

-- ---------------------------------------------------------------------------
-- Run stops
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS noma_run_stops (
  id         TEXT        PRIMARY KEY,
  thread_id  TEXT        NOT NULL REFERENCES noma_threads (id) ON DELETE CASCADE,
  run_id     TEXT        NOT NULL,
  user_id    TEXT        NOT NULL,
  agent_id   TEXT        NOT NULL,
  stopped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thread_id, run_id)
);

-- ---------------------------------------------------------------------------
-- Memórias
-- ---------------------------------------------------------------------------

-- Detecta se pgvector está disponível para usar o tipo vector.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'vector'
  ) THEN
    CREATE TABLE IF NOT EXISTS noma_memories (
      id              TEXT        PRIMARY KEY,
      user_id         TEXT        NOT NULL,
      scope           TEXT        NOT NULL DEFAULT 'user',
      kind            TEXT        NOT NULL DEFAULT 'topical',
      content         TEXT        NOT NULL,
      -- 1536 dimensões = text-embedding-3-small (OpenAI).
      -- Ajuste conforme o modelo de embedding escolhido.
      embedding       vector(1536) NULL,
      invalidated_at  TIMESTAMPTZ  NULL,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
    );

    -- Índice HNSW para busca por similaridade coseno.
    CREATE INDEX IF NOT EXISTS noma_memories_embedding_idx
      ON noma_memories
      USING hnsw (embedding vector_cosine_ops);
  ELSE
    CREATE TABLE IF NOT EXISTS noma_memories (
      id              TEXT        PRIMARY KEY,
      user_id         TEXT        NOT NULL,
      scope           TEXT        NOT NULL DEFAULT 'user',
      kind            TEXT        NOT NULL DEFAULT 'topical',
      content         TEXT        NOT NULL,
      embedding       TEXT        NULL,
      invalidated_at  TIMESTAMPTZ  NULL,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS noma_memories_user_idx
  ON noma_memories (user_id, scope, invalidated_at);
