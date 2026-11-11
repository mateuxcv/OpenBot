/**
 * Shared types for noma-runtime — replaces the type exports from @copilotkit/runtime/v2.
 *
 * Every type here is shaped to match what server/src/copilot.ts and
 * toolkit/src/copilotkit/agents.ts already expect, so the import path is the
 * only thing that changes in those files.
 */

export type { Tool } from "@ag-ui/client";
export type { LanguageModel } from "ai";

/**
 * Classic (model-driven) configuration for a built-in Bot.
 *
 * The `model` field may be a spec string such as `"openai/gpt-4o"` or a
 * resolved `LanguageModel` instance (e.g. the wrapped model from tool-search).
 */
export type BuiltInAgentClassicConfig = {
  model: string | import("ai").LanguageModel;
  prompt?: string;
  tools?: import("@ag-ui/client").Tool[];
  maxSteps?: number;
  apiKey?: string;
  providerOptions?: Record<string, unknown>;
};

/**
 * Factory configuration — the caller provides an async generator that yields
 * AG-UI `BaseEvent` values directly, bypassing the Vercel AI SDK loop.
 */
export type BuiltInAgentFactoryConfig = {
  type: "custom";
  factory: (ctx: {
    threadId: string;
    runId: string;
  }) => AsyncIterable<import("@ag-ui/client").BaseEvent>;
};

/** Full configuration accepted by {@link BuiltInAgent}. */
export type BuiltInAgentConfiguration =
  | BuiltInAgentClassicConfig
  | BuiltInAgentFactoryConfig;

/**
 * Hooks the Hono handler applies around every request.
 *
 * `onBeforeHandler` may return a replaced `Request` (e.g. after auth) or
 * `undefined` to leave it unchanged.
 */
export type CopilotRuntimeHooks = {
  onBeforeHandler?: (ctx: {
    request: Request;
    route: { method: string };
  }) => Promise<Request | undefined> | undefined;
};

/**
 * Resolves the Learning container ids for a trajectory, used by the
 * Intelligence gateway to scope Skill snapshot reads.
 */
export type GetTrajectoryLearningContainerIds = (
  trajectoryId: string,
) => Promise<string[]>;
