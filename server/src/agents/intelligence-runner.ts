/**
 * IntelligenceAgentRunner — substitui o runner do @copilotkit/runtime/v2.
 *
 * Executa um agente através do gateway WebSocket do noma-intelligence
 * (protocolo Phoenix). Usado pelo sistema de handoff para rodar Bots
 * em threads headless.
 */

import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";

export type RunnerConnection = {
  url: string;
  authToken?: string;
};

type RunRequest = {
  threadId: string;
  backendThreadId?: string;
  agent: AbstractAgent;
  input: RunAgentInput;
  persistedInputMessages?: unknown[];
  authToken?: string;
};

type RunnerStartupBoundary = {
  events: Observable<BaseEvent>;
  startup: Promise<void>;
};

/**
 * Runner que executa agentes através do gateway Noma.
 *
 * Para runs headless (handoff, rotinas), executa o agente diretamente
 * em processo via o método `run()` do agente, sem depender de um
 * WebSocket externo da CopilotKit.
 */
export class IntelligenceAgentRunner {
  readonly #connection: RunnerConnection;

  constructor(connection: RunnerConnection) {
    this.#connection = connection;
  }

  run(request: RunRequest): Observable<BaseEvent> {
    const clone = request.agent.clone() as AbstractAgent;
    return clone.run(request.input);
  }

  runWithStartupBoundary(request: RunRequest): RunnerStartupBoundary {
    const events = this.run(request);
    return {
      events,
      startup: Promise.resolve(),
    };
  }

  async isRunning(_request: { threadId: string }): Promise<boolean> {
    return false;
  }

  async stop(_request: { threadId: string; runId?: string }): Promise<boolean> {
    return false;
  }
}
