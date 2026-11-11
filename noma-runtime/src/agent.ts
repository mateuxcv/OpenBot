/**
 * BuiltInAgent — Vercel AI SDK-powered AG-UI agent.
 *
 * Replaces the BuiltInAgent exported by @copilotkit/runtime/v2.  It extends
 * AbstractAgent from @ag-ui/client and drives the model loop with `streamText`
 * from the Vercel AI SDK, converting between AG-UI message / event shapes and
 * the AI SDK's own types.
 */

import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
  type Tool,
} from "@ag-ui/client";
import { jsonSchema, streamText, type CoreMessage, type CoreTool } from "ai";
import { Observable } from "rxjs";
import type { BuiltInAgentConfiguration } from "./types.ts";
import { resolveModel } from "./model.ts";

// ---------------------------------------------------------------------------
// Message conversion: AG-UI → AI SDK
// ---------------------------------------------------------------------------

function convertMessages(messages: Message[]): {
  system: string | undefined;
  coreMessages: CoreMessage[];
} {
  const systemParts: string[] = [];
  const coreMessages: CoreMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (typeof message.content === "string") {
        systemParts.push(message.content);
      }
      continue;
    }

    if (message.role === "user") {
      if (typeof message.content === "string") {
        coreMessages.push({
          role: "user",
          content: [{ type: "text", text: message.content }],
        });
      } else if (Array.isArray(message.content)) {
        coreMessages.push({
          role: "user",
          // biome-ignore lint/suspicious/noExplicitAny: AG-UI content parts vary
          content: (message.content as any[]).map((part: any) => {
            if (part.type === "image") {
              const src = part.source ?? part.image_url ?? part;
              if (src?.type === "data" || src?.value) {
                return {
                  type: "image" as const,
                  image: src.value ?? src.data,
                  mimeType: src.mimeType,
                };
              }
              return { type: "text" as const, text: "[image]" };
            }
            return { type: "text" as const, text: part.text ?? String(part) };
          }),
        });
      }
      continue;
    }

    if (message.role === "assistant") {
      // biome-ignore lint/suspicious/noExplicitAny: AG-UI tool call shape
      const toolCalls = (message.toolCalls ?? []) as any[];
      const textContent = typeof message.content === "string" ? message.content : "";

      if (toolCalls.length > 0) {
        coreMessages.push({
          role: "assistant",
          content: [
            ...(textContent
              ? [{ type: "text" as const, text: textContent }]
              : []),
            ...toolCalls.map((call) => ({
              type: "tool-call" as const,
              toolCallId: call.id,
              toolName: call.function?.name ?? call.name ?? "",
              args: (() => {
                try {
                  return JSON.parse(call.function?.arguments ?? call.arguments ?? "{}");
                } catch {
                  return {};
                }
              })(),
            })),
          ],
        });
      } else {
        coreMessages.push({
          role: "assistant",
          content: textContent,
        });
      }
      continue;
    }

    if (message.role === "tool") {
      coreMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId ?? "",
            toolName: "",
            result:
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content),
          },
        ],
      });
      continue;
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    coreMessages,
  };
}

// ---------------------------------------------------------------------------
// Tool conversion: AG-UI → AI SDK
// ---------------------------------------------------------------------------

function convertTools(tools: Tool[]): Record<string, CoreTool> {
  const result: Record<string, CoreTool> = {};
  for (const tool of tools) {
    result[tool.name] = {
      description: tool.description ?? "",
      parameters: jsonSchema(tool.parameters ?? { type: "object", properties: {} }),
      // biome-ignore lint/suspicious/noExplicitAny: tool execute signature varies
      ...(typeof (tool as any).execute === "function"
        ? {
            execute: async (args: unknown) =>
              // biome-ignore lint/suspicious/noExplicitAny: forwarded as-is
              (tool as any).execute(args, {}),
          }
        : {}),
    } as CoreTool;
  }
  return result;
}

// ---------------------------------------------------------------------------
// BuiltInAgent
// ---------------------------------------------------------------------------

export class BuiltInAgent extends AbstractAgent {
  /**
   * The configuration this agent was constructed with. Held for `clone()`.
   */
  protected readonly config: BuiltInAgentConfiguration;

  /**
   * Telemetry tag: the provider host class. Mirrors the field CopilotKit's own
   * BuiltInAgent exposes so server-side telemetry keeps working.
   */
  modelHostClass: string = "noma";

  private abortController: AbortController | null = null;

  constructor(config: BuiltInAgentConfiguration) {
    super({});
    this.config = config;
    if (!("type" in config) || config.type !== "custom") {
      const spec = typeof config.model === "string" ? config.model : "";
      const provider = spec.split("/")[0];
      if (provider === "openai") this.modelHostClass = "openai";
      else if (provider === "anthropic") this.modelHostClass = "anthropic";
      else if (provider === "google") this.modelHostClass = "google";
      else if (spec) this.modelHostClass = "noma";
    }
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.abortController = new AbortController();
      const { signal } = this.abortController;

      const work = async () => {
        const threadId = input.threadId ?? "";
        const runId = input.runId ?? "";

        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId,
          runId,
        } as BaseEvent);

        // Factory config: delegate to the caller-supplied async generator.
        if ("type" in this.config && this.config.type === "custom") {
          for await (const event of this.config.factory({ threadId, runId })) {
            if (signal.aborted) break;
            subscriber.next(event);
          }
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
          } as BaseEvent);
          return;
        }

        // Classic config: drive the AI SDK loop.
        const cfg = this.config;
        const model =
          typeof cfg.model === "string"
            ? resolveModel(cfg.model, cfg.apiKey)
            : cfg.model;

        const { system: convertedSystem, coreMessages } = convertMessages(
          input.messages ?? [],
        );

        // Merge system prompts: config prompt takes precedence, then converted.
        const systemPrompt = [cfg.prompt, convertedSystem]
          .filter(Boolean)
          .join("\n\n") || undefined;

        const allTools: Tool[] = [
          ...(cfg.tools ?? []),
          ...(input.tools ?? []),
        ];
        // Deduplicate by name: configured tool wins over client tool.
        const toolMap = new Map<string, Tool>();
        for (const tool of allTools) toolMap.set(tool.name, tool);
        const dedupedTools = [...toolMap.values()];

        const sdkTools =
          dedupedTools.length > 0 ? convertTools(dedupedTools) : undefined;

        const result = streamText({
          model,
          messages: coreMessages,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          ...(sdkTools ? { tools: sdkTools } : {}),
          ...(cfg.maxSteps !== undefined ? { maxSteps: cfg.maxSteps } : {}),
          ...(cfg.providerOptions
            ? { providerOptions: cfg.providerOptions }
            : {}),
          abortSignal: signal,
        });

        let currentTextId: string | null = null;
        let currentToolCallId: string | null = null;
        let currentToolCallName: string | null = null;

        for await (const chunk of result.fullStream) {
          if (signal.aborted) break;

          if (chunk.type === "text-delta") {
            if (currentToolCallId !== null) {
              subscriber.next({
                type: EventType.TOOL_CALL_END,
                toolCallId: currentToolCallId,
              } as BaseEvent);
              currentToolCallId = null;
              currentToolCallName = null;
            }
            if (currentTextId === null) {
              currentTextId = crypto.randomUUID();
              subscriber.next({
                type: EventType.TEXT_MESSAGE_START,
                messageId: currentTextId,
                role: "assistant",
              } as BaseEvent);
            }
            subscriber.next({
              type: EventType.TEXT_MESSAGE_CHUNK,
              messageId: currentTextId,
              delta: chunk.textDelta,
            } as BaseEvent);
          } else if (chunk.type === "tool-call") {
            if (currentTextId !== null) {
              subscriber.next({
                type: EventType.TEXT_MESSAGE_END,
                messageId: currentTextId,
              } as BaseEvent);
              currentTextId = null;
            }
            currentToolCallId = chunk.toolCallId;
            currentToolCallName = chunk.toolName;
            subscriber.next({
              type: EventType.TOOL_CALL_START,
              toolCallId: chunk.toolCallId,
              toolCallName: chunk.toolName,
              parentMessageId: currentTextId ?? undefined,
            } as BaseEvent);
            subscriber.next({
              type: EventType.TOOL_CALL_CHUNK,
              toolCallId: chunk.toolCallId,
              argsTextDelta: JSON.stringify(chunk.args),
            } as BaseEvent);
            subscriber.next({
              type: EventType.TOOL_CALL_END,
              toolCallId: chunk.toolCallId,
            } as BaseEvent);
            currentToolCallId = null;
            currentToolCallName = null;
          } else if (chunk.type === "tool-call-streaming-start") {
            if (currentTextId !== null) {
              subscriber.next({
                type: EventType.TEXT_MESSAGE_END,
                messageId: currentTextId,
              } as BaseEvent);
              currentTextId = null;
            }
            currentToolCallId = chunk.toolCallId;
            currentToolCallName = chunk.toolName;
            subscriber.next({
              type: EventType.TOOL_CALL_START,
              toolCallId: chunk.toolCallId,
              toolCallName: chunk.toolName,
            } as BaseEvent);
          } else if (chunk.type === "tool-call-delta") {
            if (currentToolCallId !== null) {
              subscriber.next({
                type: EventType.TOOL_CALL_CHUNK,
                toolCallId: chunk.toolCallId,
                argsTextDelta: chunk.argsTextDelta,
              } as BaseEvent);
            }
          } else if (chunk.type === "tool-result") {
            if (currentToolCallId !== null) {
              subscriber.next({
                type: EventType.TOOL_CALL_END,
                toolCallId: currentToolCallId,
              } as BaseEvent);
              currentToolCallId = null;
              currentToolCallName = null;
            }
            const resultContent =
              typeof chunk.result === "string"
                ? chunk.result
                : JSON.stringify(chunk.result);
            subscriber.next({
              type: EventType.TOOL_CALL_RESULT,
              messageId: crypto.randomUUID(),
              toolCallId: chunk.toolCallId,
              role: "tool",
              content: resultContent,
            } as BaseEvent);
          } else if (chunk.type === "step-finish") {
            if (currentTextId !== null) {
              subscriber.next({
                type: EventType.TEXT_MESSAGE_END,
                messageId: currentTextId,
              } as BaseEvent);
              currentTextId = null;
            }
            if (currentToolCallId !== null) {
              subscriber.next({
                type: EventType.TOOL_CALL_END,
                toolCallId: currentToolCallId,
              } as BaseEvent);
              currentToolCallId = null;
              currentToolCallName = null;
            }
            subscriber.next({
              type: EventType.STEP_FINISHED,
              threadId,
              runId,
            } as BaseEvent);
          } else if (chunk.type === "error") {
            subscriber.next({
              type: EventType.RUN_ERROR,
              message:
                chunk.error instanceof Error
                  ? chunk.error.message
                  : String(chunk.error),
            } as BaseEvent);
            return;
          }
        }

        // Close any open text or tool call spans.
        if (currentTextId !== null) {
          subscriber.next({
            type: EventType.TEXT_MESSAGE_END,
            messageId: currentTextId,
          } as BaseEvent);
        }
        if (currentToolCallId !== null) {
          subscriber.next({
            type: EventType.TOOL_CALL_END,
            toolCallId: currentToolCallId,
          } as BaseEvent);
        }

        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
        } as BaseEvent);
      };

      void work().then(
        () => {
          if (!subscriber.closed) subscriber.complete();
        },
        (error: unknown) => {
          if (subscriber.closed) return;
          if (signal.aborted) {
            subscriber.complete();
            return;
          }
          subscriber.next({
            type: EventType.RUN_ERROR,
            message:
              error instanceof Error ? error.message : "Agent run failed.",
          } as BaseEvent);
          subscriber.complete();
        },
      );

      return () => {
        this.abortController?.abort();
      };
    });
  }

  abortRun(): void {
    this.abortController?.abort();
    super.abortRun();
  }

  clone(): BuiltInAgent {
    const cloned = new BuiltInAgent(this.config);
    type WithMiddlewares = { middlewares: unknown[] };
    (cloned as unknown as WithMiddlewares).middlewares = [
      ...(this as unknown as WithMiddlewares).middlewares,
    ];
    return cloned;
  }
}
