/**
 * Model resolution — replaces resolveModel from @copilotkit/runtime/v2.
 *
 * Parses a provider-prefixed spec such as "openai/gpt-4o" and returns a
 * Vercel AI SDK `LanguageModel` instance.  An optional `apiKey` overrides the
 * environment variable for that provider.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * Returns true when the model name requires the OpenAI Responses API.
 *
 * Models in the gpt-5.x-terra / o-series that only accept tools through
 * `/v1/responses` rather than `/v1/chat/completions` are listed here.  The
 * server's `chooseOpenAIApi` reads this to set `COPILOTKIT_OPENAI_API`.
 */
export function requiresResponsesApi(model: string): boolean {
  return (
    /^gpt-5\.\d+-terra/.test(model) ||
    /^o\d/.test(model)
  );
}

/**
 * Resolve a provider-prefixed model spec to a Vercel AI SDK `LanguageModel`.
 *
 * Supported prefixes: `openai/`, `anthropic/`, `google/`.
 * Unknown prefixes throw an error.
 *
 * When `specOrModel` is already a `LanguageModel` instance it is returned
 * unchanged, matching the behaviour of the original CopilotKit `resolveModel`.
 *
 * Base URLs are taken from `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` env vars
 * when present, matching the same normalisation that `normalizeModelBaseUrls`
 * applies in server/src/copilot.ts.
 */
export function resolveModel(
  specOrModel: string | LanguageModel,
  apiKey?: string,
): LanguageModel {
  if (typeof specOrModel !== "string") {
    return specOrModel;
  }
  const spec = specOrModel;
  const slash = spec.indexOf("/");
  if (slash === -1) {
    throw new Error(
      `noma-runtime resolveModel: spec must be "provider/model", got "${spec}"`,
    );
  }
  const provider = spec.slice(0, slash);
  const model = spec.slice(slash + 1);

  switch (provider) {
    case "openai": {
      const client = createOpenAI({
        ...(apiKey ? { apiKey } : {}),
        ...(process.env.OPENAI_BASE_URL
          ? { baseURL: process.env.OPENAI_BASE_URL }
          : {}),
      });
      return client(model);
    }

    case "anthropic": {
      const client = createAnthropic({
        ...(apiKey ? { apiKey } : {}),
        ...(process.env.ANTHROPIC_BASE_URL
          ? { baseURL: process.env.ANTHROPIC_BASE_URL }
          : {}),
      });
      return client(model);
    }

    case "bedrock": {
      const bedrock = createAmazonBedrock({
        region: process.env.AWS_REGION ?? "us-east-1",
        ...(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY
          ? {
              accessKeyId:
                process.env.AWS_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY,
              secretAccessKey:
                process.env.AWS_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_KEY,
            }
          : {}),
        ...(process.env.AWS_BEARER_TOKEN_BEDROCK
          ? { bedrockAuthToken: process.env.AWS_BEARER_TOKEN_BEDROCK }
          : {}),
      });
      return bedrock(model);
    }

    case "google": {
      // Dynamic import so the package stays optional — if @ai-sdk/google is not
      // installed the error from the import is clearer than a missing module.
      // biome-ignore lint/suspicious/noExplicitAny: dynamic optional dependency
      const { createGoogleGenerativeAI } = require("@ai-sdk/google") as any;
      const client = createGoogleGenerativeAI({
        ...(apiKey ? { apiKey } : {}),
      });
      return client(model) as LanguageModel;
    }

    default:
      throw new Error(
        `noma-runtime resolveModel: unknown provider "${provider}" in spec "${spec}"`,
      );
  }
}
