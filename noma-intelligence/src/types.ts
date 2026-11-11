/**
 * Noma Intelligence — interface pública.
 *
 * Espelha campo a campo a interface de CopilotKitIntelligence que o OpenBot
 * consome, de forma que todos os pontos de uso possam trocar a importação de
 * "@copilotkit/runtime/v2" por "@openbot/noma-intelligence/client" sem alterar
 * nenhuma outra linha de código nos pacotes server e toolkit.
 *
 * Os métodos marcados com ɵ (prefixo de API interna do CopilotKit) são
 * igualmente implementados aqui, pois o OpenBot os chama diretamente.
 */

// ---------------------------------------------------------------------------
// Tipos compartilhados
// ---------------------------------------------------------------------------

export type MemoryGrant = {
  user: "read-write" | "read-only" | "none";
  project: "read-write" | "read-only" | "none";
};

export type MemoryKind = "topical" | "episodic" | "semantic";
export type MemoryScope = "user" | "project";

export type MemoryItem = {
  id: string;
  content: string;
  scope: MemoryScope;
  kind: MemoryKind;
  invalidatedAt: string | null;
  score?: number;
};

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

export type RuntimeEntitlementResponse =
  | {
      status: "ready";
      entitlement: {
        active: boolean;
        planCode?: string;
        source?: string;
        features: {
          memory: boolean;
          learning: boolean;
        };
      };
    }
  | {
      status: "error" | "unavailable" | "misconfigured" | "expired";
      error?: { code?: string; message?: string };
    };

// ---------------------------------------------------------------------------
// Thread / lock
// ---------------------------------------------------------------------------

export type GetOrCreateThreadParams = {
  threadId: string;
  userId: string;
  agentId: string;
  learningContainerId?: string;
};

export type GetOrCreateThreadResult = {
  threadId: string;
  backendThreadId?: string;
  isNew: boolean;
};

export type GetThreadParams = {
  threadId: string;
  userId: string;
};

export type GetThreadResult = {
  threadId: string;
  backendThreadId?: string;
  metadata?: Record<string, unknown>;
};

export type GetThreadMessagesParams = {
  threadId: string;
  userId: string;
  channelDeliveryId?: string;
};

export type ThreadMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string | unknown[];
  createdAt?: string;
  [key: string]: unknown;
};

export type GetThreadMessagesResult = {
  messages: ThreadMessage[];
};

export type AcquireThreadLockParams = {
  threadId: string;
  runId: string;
  userId: string;
  agentId: string;
  learningContainerId?: string;
  channelDeliveryId?: string;
  supportsBackendThreadId?: boolean;
  requestId?: string;
  lockKeyPrefix?: string;
  ttlSeconds?: number;
};

export type AcquireThreadLockResult = {
  runId: string;
  joinToken?: string;
};

export type RenewThreadLockParams = {
  threadId: string;
  runId: string;
  userId: string;
  ttlSeconds?: number;
};

export type CleanupThreadLockParams = {
  threadId: string;
  runId: string;
  userId: string;
};

export type RecordRunStopParams = {
  threadId: string;
  runId: string;
  userId: string;
  agentId: string;
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export type ListMemoriesParams = {
  userId: string;
  memoryGrant: MemoryGrant;
};

export type ListMemoriesResult = {
  memories: MemoryItem[];
};

export type RecallMemoriesParams = {
  userId: string;
  memoryGrant: MemoryGrant;
  query: string;
  limit: number;
  scope: MemoryScope;
};

export type RecallMemoriesResult = {
  memories: MemoryItem[];
};

export type CreateMemoryParams = {
  userId: string;
  memoryGrant: MemoryGrant;
  content: string;
  kind: MemoryKind;
  scope: MemoryScope;
};

export type CreateMemoryResult = {
  id: string;
};

export type UpdateMemoryParams = {
  userId: string;
  memoryGrant: MemoryGrant;
  id: string;
  content: string;
  kind: MemoryKind;
  scope: MemoryScope;
};

export type UpdateMemoryResult = {
  id: string;
};

export type RemoveMemoryParams = {
  userId: string;
  id: string;
  memoryGrant: MemoryGrant;
};

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

export type InspectorMetadata = {
  url?: string;
  available: boolean;
};

// ---------------------------------------------------------------------------
// Interface principal
// ---------------------------------------------------------------------------

/**
 * Contrato completo que o OpenBot espera de um cliente de Intelligence.
 * Todos os pontos de uso no server e toolkit dependem apenas desta interface.
 */
export interface NomaIntelligenceClient {
  // Configuração (APIs internas usadas em toolkit/agents.ts e intelligence-client.ts)
  ɵgetApiUrl(): string;
  ɵgetApiKey(): string;
  ɵgetClientWsUrl(): string;

  // Entitlements
  getRuntimeEntitlements(): Promise<RuntimeEntitlementResponse>;

  // Threads
  getOrCreateThread(
    params: GetOrCreateThreadParams,
  ): Promise<GetOrCreateThreadResult>;
  getThread(params: GetThreadParams): Promise<GetThreadResult>;
  getThreadMessages(
    params: GetThreadMessagesParams,
  ): Promise<GetThreadMessagesResult>;

  // Lock de execução
  ɵacquireThreadLock(
    params: AcquireThreadLockParams,
  ): Promise<AcquireThreadLockResult>;
  ɵrenewThreadLock(params: RenewThreadLockParams): Promise<void>;
  ɵcleanupThreadLock(params: CleanupThreadLockParams): Promise<void>;

  // Stop de run
  ɵrecordRunStop?(params: RecordRunStopParams): Promise<void>;

  // Memória
  listMemories(params: ListMemoriesParams): Promise<ListMemoriesResult>;
  recallMemories(params: RecallMemoriesParams): Promise<RecallMemoriesResult>;
  createMemory(params: CreateMemoryParams): Promise<CreateMemoryResult>;
  updateMemory(params: UpdateMemoryParams): Promise<UpdateMemoryResult>;
  removeMemory(params: RemoveMemoryParams): Promise<void>;

  // Inspector (opcional, usado no Learning inspector)
  getInspectorMetadata?(): Promise<InspectorMetadata>;
}
