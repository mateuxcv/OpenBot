/**
 * noma-runtime — public API.
 *
 * Re-exports everything from the package's modules so callers can import from
 * the package root:
 *
 *   import { BuiltInAgent, resolveModel, createNomaHonoHandler } from "@openbot/noma-runtime";
 *
 * or from a specific module path:
 *
 *   import { BuiltInAgent } from "@openbot/noma-runtime/agent";
 */

export type {
  BuiltInAgentClassicConfig,
  BuiltInAgentConfiguration,
  BuiltInAgentFactoryConfig,
  CopilotRuntimeHooks,
  GetTrajectoryLearningContainerIds,
  LanguageModel,
  Tool,
} from "./types.ts";

export { resolveModel, requiresResponsesApi } from "./model.ts";

export { BuiltInAgent } from "./agent.ts";

export { InMemoryAgentRunner } from "./runner.ts";

export { createNomaHonoHandler } from "./handler.ts";
export type { NomaHonoHandlerOptions } from "./handler.ts";

export {
  createSafeUrlDownload,
} from "./download.ts";
export type {
  DownloadLink,
  DownloadResult,
  SafeUrlDownloadOptions,
} from "./download.ts";

export {
  formatSkillCatalog,
  loadSkill,
  readSkillFile,
  SkillRegistry,
} from "./skills.ts";
export type {
  SkillRegistryStatus,
  SnapshotFile,
  SnapshotSkill,
  VerifiedSnapshot,
} from "./skills.ts";
