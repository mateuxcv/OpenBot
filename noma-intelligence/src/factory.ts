/**
 * Fábrica de alto nível para criar uma instância completa de Noma Intelligence.
 *
 * Uso no server/src/index.ts (ou onde Intelligence é instanciada):
 *
 *   import { createNoma } from "@openbot/noma-intelligence/factory";
 *   import postgres from "postgres";
 *
 *   const sql = postgres(process.env.DATABASE_URL!);
 *   const noma = createNoma({
 *     sql,
 *     apiUrl: "http://localhost:3001",
 *     gatewayWsUrl: "ws://localhost:3001/api/noma/gateway",
 *     apiKey: "noma-local",
 *     // embeddings: createOpenAIEmbeddings(process.env.OPENAI_API_KEY!),
 *   });
 *
 *   // noma.intelligence é o substituto direto de CopilotKitIntelligence.
 *   // noma.gateway.broadcaster é usado pelo runner para publicar eventos AG-UI.
 */

import { NomaIntelligence } from "./client";
import { createNomaEntitlements } from "./entitlements";
import { createNomaGateway } from "./gateway";
import {
  createPostgresMemoryDatabase,
  createMemoryStore,
  type EmbeddingProvider,
} from "./memory";
import { createPostgresThreadDatabase, createThreadStore } from "./threads";
import type { NomaIntelligenceOptions } from "./client";

type SqlExecutor = {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
};

export type CreateNomaOptions = {
  sql: SqlExecutor;
  apiUrl: string;
  gatewayWsUrl: string;
  /** Qualquer string — mantida apenas para compatibilidade com a interface. */
  apiKey?: string;
  /** Provider de embeddings. Sem ele, recall usa busca por substring. */
  embeddings?: EmbeddingProvider;
};

export type NomaInstance = {
  intelligence: NomaIntelligence;
  gateway: ReturnType<typeof createNomaGateway>;
};

export function createNoma(options: CreateNomaOptions): NomaInstance {
  const { sql, apiUrl, gatewayWsUrl, embeddings } = options;
  const apiKey = options.apiKey ?? "noma-local";

  const threadDatabase = createPostgresThreadDatabase(sql);
  const threads = createThreadStore(threadDatabase);

  const memoryDatabase = createPostgresMemoryDatabase(sql);
  const memory = createMemoryStore({ database: memoryDatabase, embeddings });

  const entitlements = createNomaEntitlements();
  const gateway = createNomaGateway();

  const intelligence = new NomaIntelligence({
    apiUrl,
    gatewayWsUrl,
    apiKey,
    threads,
    memory,
    entitlements,
  } satisfies NomaIntelligenceOptions);

  return { intelligence, gateway };
}

// Re-exporta tudo que o server e o toolkit precisam importar.
export { NomaIntelligence } from "./client";
export { PlatformRequestError } from "./errors";
export type { NomaIntelligenceClient, RuntimeEntitlementResponse } from "./types";
export { createNomaGateway, ConversationBroadcaster, PhoenixConnection } from "./gateway";
export type { EmbeddingProvider } from "./memory";
