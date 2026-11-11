/**
 * createNomaHonoHandler — Hono-based AG-UI HTTP handler.
 *
 * Replaces createCopilotHonoHandler from @copilotkit/runtime/v2/hono.
 * Mounts three routes on a Hono app and returns it:
 *
 *   POST /agent/:agentId/run  — start a run, stream SSE events
 *   POST /agent/:agentId/stop — abort the current run
 *   GET  /info                — runtime info
 */

import type { AbstractAgent, RunAgentInput } from "@ag-ui/client";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import type { CopilotRuntimeHooks } from "./types.ts";

export type NomaHonoHandlerOptions = {
  runtime: {
    agents: Record<string, AbstractAgent>;
  };
  basePath?: string;
  cors?: Parameters<typeof cors>[0];
  hooks?: CopilotRuntimeHooks;
};

/**
 * AG-UI SSE event envelope as sent over the wire.
 *
 * We serialise each BaseEvent as `data: <json>\n\n` following the SSE spec,
 * which is what the AG-UI client library's `HttpAgent` expects.
 */
function sseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function createNomaHonoHandler(
  options: NomaHonoHandlerOptions,
): Hono {
  const { runtime, hooks } = options;
  const app = new Hono();

  // CORS — applied to all routes when configured.
  if (options.cors) {
    app.use("*", cors(options.cors));
  }

  // GET /info — advertise which agents this runtime serves.
  app.get("/info", (c) => {
    return c.json({
      agents: Object.keys(runtime.agents).map((id) => ({
        id,
        description: runtime.agents[id]?.description ?? "",
      })),
    });
  });

  // POST /agent/:agentId/run — execute an agent and stream AG-UI events.
  app.post("/agent/:agentId/run", async (c) => {
    // Apply before-handler hook when present.
    let request = c.req.raw;
    if (hooks?.onBeforeHandler) {
      const replaced = await hooks.onBeforeHandler({
        request,
        route: { method: "POST" },
      });
      if (replaced) request = replaced;
    }

    const { agentId } = c.req.param();
    const agent = runtime.agents[agentId];
    if (!agent) {
      return c.json({ error: `Agent "${agentId}" not found.` }, 404);
    }

    let input: RunAgentInput;
    try {
      input = (await request.json()) as RunAgentInput;
    } catch {
      return c.json({ error: "Invalid JSON body." }, 400);
    }

    // Clone so the registry still holds the original for the next request.
    const clone = agent.clone() as AbstractAgent;

    return stream(c, async (s) => {
      await new Promise<void>((resolve, reject) => {
        const subscription = clone.run(input).subscribe({
          next: async (event) => {
            try {
              await s.write(sseEvent(event));
            } catch {
              subscription.unsubscribe();
              resolve();
            }
          },
          error: async (err: unknown) => {
            try {
              await s.write(
                sseEvent({
                  type: "RUN_ERROR",
                  message:
                    err instanceof Error ? err.message : "Run failed.",
                }),
              );
            } catch {
              // ignore write errors on a closing stream
            }
            reject(err);
          },
          complete: resolve,
        });
      }).catch(() => {
        // Errors are surfaced as RUN_ERROR events; swallow here to close cleanly.
      });
    });
  });

  // POST /agent/:agentId/stop — abort an in-progress run.
  app.post("/agent/:agentId/stop", async (c) => {
    const { agentId } = c.req.param();
    const agent = runtime.agents[agentId];
    if (!agent) {
      return c.json({ error: `Agent "${agentId}" not found.` }, 404);
    }
    agent.abortRun();
    return c.json({ stopped: true });
  });

  return app;
}
