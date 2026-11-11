/**
 * NomaIntelligence — implementação completa da interface de Intelligence.
 *
 * Esta classe substitui CopilotKitIntelligence do @copilotkit/runtime/v2 em
 * todos os pontos de uso do OpenBot. A interface é idêntica campo a campo,
 * incluindo os métodos internos prefixados com ɵ.
 *
 * Instâncias são criadas por createNomaIntelligence() e usadas em:
 *   - server/src/intelligence-client.ts (createIntelligenceClient)
 *   - toolkit/src/copilotkit/agents.ts (IntelligenceKnowingANewThread)
 *   - toolkit/src/copilotkit/thread-lock.ts (createIntelligenceThreadLock)
 *   - server/src/memory/intelligence.ts (IntelligenceMemoryClient)
 *   - server/src/self-host-banner.ts (SelfHostBanner)
 */

import type { NomaIntelligenceClient, RuntimeEntitlementResponse } from "./types";
import type { createThreadStore } from "./threads";
import type { createMemoryStore } from "./memory";
import type { createNomaEntitlements } from "./entitlements";
import type {
  AcquireThreadLockParams,
  AcquireThreadLockResult,
  CleanupThreadLockParams,
  CreateMemoryParams,
  CreateMemoryResult,
  GetOrCreateThreadParams,
  GetOrCreateThreadResult,
  GetThreadMessagesParams,
  GetThreadMessagesResult,
  GetThreadParams,
  GetThreadResult,
  InspectorMetadata,
  ListMemoriesParams,
  ListMemoriesResult,
  RecallMemoriesParams,
  RecallMemoriesResult,
  RecordRunStopParams,
  RemoveMemoryParams,
  RenewThreadLockParams,
  UpdateMemoryParams,
  UpdateMemoryResult,
} from "./types";

export type NomaIntelligenceOptions = {
  /** URL desta instância (usada pelo OpenBot para passar ao browser via /info). */
  apiUrl: string;
  /** URL do gateway WebSocket Phoenix. */
  gatewayWsUrl: string;
  /** Chave de API (qualquer string — apenas para manter a interface). */
  apiKey: string;
  threads: ReturnType<typeof createThreadStore>;
  memory: ReturnType<typeof createMemoryStore>;
  entitlements: ReturnType<typeof createNomaEntitlements>;
};

export class NomaIntelligence implements NomaIntelligenceClient {
  readonly #apiUrl: string;
  readonly #gatewayWsUrl: string;
  readonly #apiKey: string;
  readonly #threads: ReturnType<typeof createThreadStore>;
  readonly #memory: ReturnType<typeof createMemoryStore>;
  readonly #entitlements: ReturnType<typeof createNomaEntitlements>;

  constructor(options: NomaIntelligenceOptions) {
    this.#apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.#gatewayWsUrl = options.gatewayWsUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#threads = options.threads;
    this.#memory = options.memory;
    this.#entitlements = options.entitlements;
  }

  // ---------------------------------------------------------------------------
  // Configuração (métodos ɵ internos)
  // ---------------------------------------------------------------------------

  ɵgetApiUrl(): string {
    return this.#apiUrl;
  }

  ɵgetApiKey(): string {
    return this.#apiKey;
  }

  ɵgetClientWsUrl(): string {
    // Converte http(s) → ws(s) e aponta para /client conforme a convenção
    // que o runtime usa em deriveClientWsUrl.
    const base = this.#gatewayWsUrl.replace(/^http/, "ws");
    for (const suffix of ["/client", "/runner", "/channels"]) {
      if (base.endsWith(suffix)) return `${base.slice(0, -suffix.length)}/client`;
    }
    return `${base}/client`;
  }

  // ---------------------------------------------------------------------------
  // Entitlements
  // ---------------------------------------------------------------------------

  async getRuntimeEntitlements(): Promise<RuntimeEntitlementResponse> {
    return this.#entitlements.getRuntimeEntitlements();
  }

  // ---------------------------------------------------------------------------
  // Threads
  // ---------------------------------------------------------------------------

  async getOrCreateThread(
    params: GetOrCreateThreadParams,
  ): Promise<GetOrCreateThreadResult> {
    return this.#threads.getOrCreate(params);
  }

  async getThread(params: GetThreadParams): Promise<GetThreadResult> {
    return this.#threads.get(params);
  }

  async getThreadMessages(
    params: GetThreadMessagesParams,
  ): Promise<GetThreadMessagesResult> {
    return this.#threads.getMessages(params);
  }

  // ---------------------------------------------------------------------------
  // Lock de execução
  // ---------------------------------------------------------------------------

  async ɵacquireThreadLock(
    params: AcquireThreadLockParams,
  ): Promise<AcquireThreadLockResult> {
    return this.#threads.acquireLock(params);
  }

  async ɵrenewThreadLock(params: RenewThreadLockParams): Promise<void> {
    return this.#threads.renewLock(params);
  }

  async ɵcleanupThreadLock(params: CleanupThreadLockParams): Promise<void> {
    return this.#threads.releaseLock(params);
  }

  async ɵrecordRunStop(params: RecordRunStopParams): Promise<void> {
    if (params.signal?.aborted) return;
    return this.#threads.recordStop(params);
  }

  // ---------------------------------------------------------------------------
  // Memória
  // ---------------------------------------------------------------------------

  async listMemories(params: ListMemoriesParams): Promise<ListMemoriesResult> {
    return this.#memory.list(params);
  }

  async recallMemories(
    params: RecallMemoriesParams,
  ): Promise<RecallMemoriesResult> {
    return this.#memory.recall(params);
  }

  async createMemory(params: CreateMemoryParams): Promise<CreateMemoryResult> {
    return this.#memory.create(params);
  }

  async updateMemory(params: UpdateMemoryParams): Promise<UpdateMemoryResult> {
    return this.#memory.update(params);
  }

  async removeMemory(params: RemoveMemoryParams): Promise<void> {
    return this.#memory.remove(params);
  }

  // ---------------------------------------------------------------------------
  // Inspector (opcional — Learning inspector do OpenBot)
  // ---------------------------------------------------------------------------

  async getInspectorMetadata(): Promise<InspectorMetadata> {
    return { available: false };
  }
}
