/**
 * InMemoryAgentRunner — a minimal headless runner for BuiltInAgent.
 *
 * Keeps per-thread state in memory and delegates run execution directly to
 * the agent.  For production use the Intelligence gateway runner replaces
 * this with one that speaks the WebSocket gateway protocol from
 * @openbot/noma-intelligence.
 */

import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import type { Observable } from "rxjs";

export class InMemoryAgentRunner {
  private readonly threads = new Map<string, { messages: unknown[] }>();

  /**
   * Execute `agent` for the given `input` on `threadId`.
   *
   * The agent is cloned before the run so each invocation is independent.
   * Returns the raw Observable from the agent; the caller is responsible for
   * subscribing and streaming the events.
   */
  run(
    agent: AbstractAgent,
    input: RunAgentInput,
    _threadId: string,
  ): Observable<BaseEvent> {
    const clone = agent.clone() as AbstractAgent;
    return clone.run(input);
  }

  /**
   * Store the final message list for a thread after a run completes.
   * Used by callers that want to persist the conversation in memory between
   * turns on the same process.
   */
  updateThread(threadId: string, messages: unknown[]): void {
    this.threads.set(threadId, { messages });
  }

  /** The messages stored for a thread, or an empty array when unknown. */
  getThreadMessages(threadId: string): unknown[] {
    return this.threads.get(threadId)?.messages ?? [];
  }
}
