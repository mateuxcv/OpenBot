import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type Middleware,
  type MiddlewareFunction,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  BuiltInAgent,
  type BuiltInAgentConfiguration,
} from "@copilotkit/runtime/v2";
import {
  NomaIntelligence,
  PlatformRequestError,
} from "@openbot/noma-intelligence/factory";
import type { NomaIntelligenceClient } from "@openbot/noma-intelligence/factory";
import {
  defer,
  finalize,
  from,
  fromEvent,
  type Observable,
  of,
  switchMap,
  takeUntil,
} from "rxjs";
import { sanitizeSeededHistory } from "../history-sanitize";
import { firingChecklist } from "./firing-checklist";
import { answersOnLastStep, type RunSteps, startRun } from "./last-step";
import { oneMessagePerStep } from "./step-messages";
import {
  type NativeRunScope,
  nativeApprovalRun,
  nativeRunScope,
  withinNativeRun,
} from "../native-approval";
import { historyOrEmpty } from "../thread-history";

/**
 * The CopilotKit agents OpenBot runs its Bots as: a built-in Bot that will not send a broken
 * conversation, one whose tools are chosen when its run starts, a remote Bot that survives being
 * cloned, a Bot that is no longer there, and the platform client with its expected answers kept quiet.
 *
 * Moved out of the server's copilot.ts. What the server does around a run — inlining attachments,
 * watching the model connection — comes in as {@link BuiltInAgentHooks}, so nothing here imports it.
 */

/**
 * The reason a finished run's build is aborted with, so a pending model call can tell a run that
 * ended normally from one somebody stopped. Read by the server's plan model.
 */
export const PLAN_RUN_COMPLETED = Symbol("plan-run-completed");

/** The RUN_ERROR code of a built-in run refused before its model call by `admitTools`. */
export const TOOL_LIMIT_EXCEEDED = "OPENBOT_TOOL_LIMIT_EXCEEDED";

type AgentHeaders = Record<string, string>;
type HeaderBearingAgent = AbstractAgent & { headers?: AgentHeaders };

/** What the host does around a built-in Bot's run. */
export type BuiltInAgentHooks = {
  /**
   * Replace a person's attached files with their bytes, given the run's conversation. Absent, the
   * conversation goes up as it is, without deferring the run.
   */
  inline?: (messages: Message[], threadId: string) => Promise<Message[]>;
  /** Watch the model connection, for a host that reports when it fails. */
  observe: (run: Observable<BaseEvent>) => Observable<BaseEvent>;
  /**
   * Decide, before the model is called, whether a run that would send these tools may go ahead.
   * A sentence refuses it: the run ends with that sentence as its RUN_ERROR and no provider is
   * called. Absent, every run goes ahead. See {@link toolNamesSent} for what the names are.
   */
  admitTools?: (toolNames: readonly string[]) => string | undefined;
  /** The configured tools that wait behind tool search, which {@link toolNamesSent} leaves out. */
  waiting?: ReadonlySet<string>;
  /**
   * Say whose words each message is, where the role alone would say it wrong: another Bot's answer
   * stored in this Bot's thread as an assistant message. The last thing done to the history before
   * the provider, after the sanitiser and the attachments, so neither of those reads a re-roled
   * message as something the person said. Absent, the history goes up as those two left it.
   */
  attribute?: (messages: Message[]) => Message[];
  /**
   * Nobody is watching this run: a routine's firing or a check-in. It gets the step budget of work
   * that has to finish on its own (`UNATTENDED_STEPS`) rather than chat's. Absent, a person is.
   */
  unattended?: boolean;
};

/**
 * The tools `BuiltInAgent.run` adds to every run, whatever it was configured with.
 *
 * Copied from `@copilotkit/runtime`'s agent (`dist/agent/index.mjs`, where `run` spreads them into
 * `streamTextParams.tools`), because a count that leaves them out is two short of what the provider
 * is sent, and a limit is exactly where two matters.
 */
export const RUNTIME_STATE_TOOLS = [
  "AGUISendStateSnapshot",
  "AGUISendStateDelta",
] as const;

/**
 * The names of the tools a built-in run will send its model provider on its first step, before
 * anything is sent.
 *
 * The same union `BuiltInAgent.run` makes: the client's tools from the request, the configured
 * tools over them (by name, so a client tool the Bot also holds is one tool, not two), and the
 * runtime's own state tools. Less whatever waits behind tool search, which is registered with the
 * runtime and not sent until a search finds it, and then only into the room left under the limit.
 * Counting it would refuse exactly the runs search exists to let through. A factory configuration
 * declares no tools here.
 */
export function toolNamesSent(
  configuration: BuiltInAgentConfiguration,
  input: Pick<RunAgentInput, "tools">,
  waiting: ReadonlySet<string> = new Set(),
): string[] {
  const configured =
    "tools" in configuration ? (configuration.tools ?? []) : [];
  return [
    ...new Set([
      ...(input.tools ?? []).map((tool) => tool.name),
      ...configured.map((tool) => tool.name),
      ...RUNTIME_STATE_TOOLS,
    ]),
  ].filter((name) => !waiting.has(name));
}

export class CloningRemoteAgent extends AbstractAgent {
  headers?: AgentHeaders;
  private readonly remote: HeaderBearingAgent;
  private extraMiddleware: (Middleware | MiddlewareFunction)[] = [];
  private captureExtraMiddleware = false;

  override use(...middleware: (Middleware | MiddlewareFunction)[]): this {
    super.use(...middleware);
    if (this.captureExtraMiddleware) this.extraMiddleware.push(...middleware);
    return this;
  }

  constructor(
    remote: AbstractAgent,
    private readonly attachOpenBotMiddleware: (target: AbstractAgent) => void,
  ) {
    super({
      agentId: remote.agentId,
      description: remote.description,
      threadId: remote.threadId,
      initialMessages: remote.messages,
      initialState: remote.state,
      debug: remote.debug,
    });
    this.remote = remote as HeaderBearingAgent;
    if (this.remote.headers) {
      this.headers = { ...this.remote.headers };
    }
    this.attachOpenBotMiddleware(this);
    this.captureExtraMiddleware = true;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    if (this.headers) {
      this.remote.headers = { ...this.headers };
    }
    return this.remote.run(input);
  }

  async getCapabilities() {
    return this.remote.getCapabilities?.() ?? {};
  }

  abortRun(): void {
    this.remote.abortRun();
    super.abortRun();
  }

  clone() {
    const clonedRemote = this.remote.clone() as AbstractAgent;
    const clone = new CloningRemoteAgent(
      clonedRemote,
      this.attachOpenBotMiddleware,
    );
    clone.use(...this.extraMiddleware);
    if (this.headers) {
      clone.headers = { ...this.headers };
    }
    return clone;
  }
}

/**
 * A built-in Bot that will not hand the model provider a conversation it is going to refuse.
 *
 * FOUND LIVE, ON CHAT. One person's next three messages each failed with
 * `AI_MissingToolResultsError: Tool result is missing for tool call chatcmpl-tool-8dd56dc7497c5ea9`,
 * thrown out of the AI SDK's `convertToLanguageModelPrompt`. A frontend tool handler had been torn
 * down while its call was open, so the agent's live messages in the browser carried an assistant
 * message whose tool call never got a result. The durable store did not have it, nothing was going
 * to answer it, and every retry sent it straight back up as `input.messages`. The conversation was
 * finished until the person worked out for themselves to start another one.
 *
 * The guard has to be on this side of `run`. `BuiltInAgent.run` converts `input.messages` itself,
 * with no seam in between, so wrapping the agent is the only place left to stand. The reasoning for
 * why a dangling call is DROPPED rather than repaired, and why ids are never changed, is in
 * `toolkit/history-sanitize.ts`, where the routines path found the same failure first.
 *
 * A RESUMED CALL IS NOT A DANGLE. `run` appends a tool result for each `input.resume` entry by
 * `interruptId` AFTER converting the messages, so a call that a resume is about to answer must
 * survive this pass or the appended result lands on nothing.
 */
export class BuiltInAgentWithSaneHistory extends BuiltInAgent {
  /**
   * The configuration, held a second time because the base class keeps its own copy private and
   * {@link clone} has to build another one of THIS class rather than of the base.
   */
  private readonly configuration: BuiltInAgentConfiguration;
  /**
   * What the host does around a run: how it inlines a person's attached files, and how it watches
   * the model connection. Held for the same reason {@link configuration} is: {@link clone} builds
   * another one of THIS class, and a seam lost in a clone is a seam that never runs.
   */
  private readonly hooks: BuiltInAgentHooks;
  /**
   * The run this agent is in, which its tools re-enter when the AI SDK calls them. One per agent,
   * and so one per clone: the runtime clones before every run. See `NativeRunScope`.
   */
  private readonly scope: NativeRunScope;
  /** Where this run's steps began, so its last one is sent without tools. See `answersOnLastStep`. */
  private readonly steps: RunSteps;

  constructor(
    configuration: BuiltInAgentConfiguration,
    hooks: BuiltInAgentHooks,
  ) {
    const scope = nativeRunScope();
    const steps: RunSteps = {};
    super(
      toolsWithin(
        // Outside the last step's wrapper, so a step it asks twice is still one message.
        oneMessagePerStep(
          answersOnLastStep(configuration, steps, {
            unattended: hooks.unattended === true,
          }),
        ),
        scope,
      ),
    );
    this.configuration = configuration;
    this.hooks = hooks;
    this.scope = scope;
    this.steps = steps;
    /*
     * The runtime names where a model is hosted from its name, for its own telemetry, and a model
     * handed over already wrapped has no name to read. Named from the configuration it was given.
     */
    if (!("factory" in configuration))
      (this as { modelHostClass: string }).modelHostClass = new BuiltInAgent({
        model: configuration.model,
      }).modelHostClass;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    /*
     * FIRST, before the history is touched or an attachment is stamped as sent. A run refused here
     * never started, and nothing downstream should record it as though it had.
     */
    const refusal = this.hooks.admitTools?.(
      toolNamesSent(this.configuration, input, this.hooks.waiting),
    );
    if (refusal !== undefined)
      return of(
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent,
        {
          type: EventType.RUN_ERROR,
          message: refusal,
          code: TOOL_LIMIT_EXCEEDED,
        } as BaseEvent,
      );
    const answeredByResume = new Set(
      (input.resume ?? []).map((entry) => entry.interruptId),
    );
    const history = sanitizeSeededHistory(input.messages, answeredByResume);
    // A routine's firing carries the checklist it has to close. See `firingChecklist`.
    const checklist = firingChecklist(history);
    // A new run counts its steps from where it starts, never from where an earlier run stopped.
    startRun(this.steps, checklist.parts);
    const { inline, observe, attribute } = this.hooks;
    /*
     * Last, after both passes that read roles, and only on the way to the model. The approval
     * continuation keeps the conversation as the thread holds it, and is attributed again when it
     * resumes. See `BuiltInAgentHooks.attribute`.
     */
    const toModel = (messages: Message[]) =>
      observe(
        super.run({
          ...input,
          messages: checklist.toModel(
            attribute ? attribute(messages) : messages,
          ),
        }),
      );
    /*
     * ALONGSIDE THE GUARD ABOVE, NOT INSTEAD OF IT. One drops a conversation the model provider is
     * going to refuse; this replaces the stored reference a person's attachment arrives as with the
     * bytes themselves, because `BuiltInAgent.run` converts `input.messages` with no seam in
     * between and a `/api/attachments/<id>` URL is not something a model provider will go and fetch.
     *
     * Nothing to load means nothing to inline, and the run goes up exactly as it did before any of
     * this existed.
     */
    if (!inline)
      return nativeApprovalRun(
        { ...input, messages: history },
        () => toModel(history),
        this.scope,
      );
    /*
     * Deferred, because `run` has to answer with a stream straight away and reading the bytes is a
     * database round trip. `defer` puts that read on the subscription, which is where the run
     * actually begins, so nothing is fetched until somebody is listening.
     */
    return defer(() =>
      from(
        // The run's own conversation, not the actor's channels at large.
        inline(history, input.threadId),
      ).pipe(
        switchMap((messages) =>
          nativeApprovalRun(
            { ...input, messages },
            () => toModel(messages),
            this.scope,
          ),
        ),
      ),
    );
  }

  override abortRun(): void {
    super.abortRun();
    // A suspension already stopped the provider. Stop must also close its tool-settlement wait,
    // even when a tool is still finishing work that does not observe the provider's abort signal.
    this.scope.run?.abort();
  }

  /**
   * Carried by hand, for the same reason {@link RunBuiltAgent.clone} is.
   *
   * The runtime clones an agent before every run, and the base class's clone hard-codes
   * `new BuiltInAgent(this.config)`: inherited unchanged, the very first message anybody sends
   * would go through an agent that does none of the above. The middleware list is copied because
   * the base clone copies it, and it is reached through a cast because `AbstractAgent` declares it
   * private. Nothing registers middleware on a built-in Bot today, and this is here so that the day
   * something does, it is not lost in a clone.
   */
  clone(): BuiltInAgentWithSaneHistory {
    const cloned = new BuiltInAgentWithSaneHistory(
      this.configuration,
      this.hooks,
    );
    type WithMiddlewares = { middlewares: unknown[] };
    (cloned as unknown as WithMiddlewares).middlewares = [
      ...(this as unknown as WithMiddlewares).middlewares,
    ];
    return cloned;
  }
}

/**
 * The configuration with each tool's execute re-entering the agent's run, so a tool the AI SDK calls
 * from a stream that lost its async context still asks in the conversation that called it. A factory
 * configuration builds its own tools and has none here.
 */
function toolsWithin(
  configuration: BuiltInAgentConfiguration,
  scope: NativeRunScope,
): BuiltInAgentConfiguration {
  if ("factory" in configuration || !configuration.tools) return configuration;
  return {
    ...configuration,
    tools: configuration.tools.map((tool) =>
      tool.execute
        ? { ...tool, execute: withinNativeRun(scope, tool.execute) }
        : tool,
    ),
  };
}

/**
 * An agent whose tools are decided when the run starts, because that is the first moment anybody
 * knows what the run is about, and who is asking on whose behalf.
 *
 * WHY A WRAPPER AND NOT A NARROWER `loadTools`. Tools are resolved per request, and a request is
 * earlier than a run: at that point there is a Bot and a person and no message, so there is nothing
 * to select against. `run(input)` is the first place the message exists. Both underlying agents take
 * their tools at construction — a built-in one in its configuration, a remote one in the middleware
 * that sends them — so the only way to hand either a set chosen from the message is to build it
 * after the message arrives. That is all this does: it defers `build` to the first subscription and
 * then gets out of the way.
 *
 * The deferral is per subscription, so a retried run reselects rather than reusing a decision made
 * for a message that is no longer the last one.
 */
export class RunBuiltAgent extends AbstractAgent {
  /**
   * Stop must reach the pending build as well as the eventual model. Keep both in one per-run
   * record so a late build or teardown cannot replace the next run's cancellation target.
   */
  private active?: { controller: AbortController; inner?: AbstractAgent };
  /** The same Bot with nothing narrowed, kept to answer questions that are not about one run. */
  private whole: AbstractAgent;
  private build: (
    input: RunAgentInput,
    signal: AbortSignal,
  ) => Promise<AbstractAgent>;

  constructor(
    identity: { agentId: string; description: string },
    whole: AbstractAgent,
    build: (
      input: RunAgentInput,
      signal: AbortSignal,
    ) => Promise<AbstractAgent>,
  ) {
    super(identity);
    this.whole = whole;
    this.build = build;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return defer(() => {
      const active: NonNullable<RunBuiltAgent["active"]> = {
        controller: new AbortController(),
      };
      this.active = active;
      const { signal } = active.controller;
      return defer(() => this.build(input, signal)).pipe(
        switchMap((agent) => {
          signal.throwIfAborted();
          active.inner = agent;
          return agent.run(input);
        }),
        // Settle Stop even if a collaborator ignores the signal or rejects after cancellation.
        takeUntil(fromEvent(signal, "abort")),
        finalize(() => {
          if (this.active === active) this.active = undefined;
          active.controller.abort(PLAN_RUN_COMPLETED);
        }),
      );
    });
  }

  /**
   * What the Bot can do, answered from the un-narrowed agent.
   *
   * Capabilities are asked for outside a run, where there is no message and so nothing to select
   * against. They are also a fact about the Bot rather than about one turn: a deployment that
   * narrowed this run to three tools has not stopped supporting whatever the underlying agent
   * supports.
   */
  getCapabilities() {
    return this.whole.getCapabilities?.() ?? Promise.resolve({});
  }

  /**
   * Carried by hand, because `AbstractAgent.clone` does not know this class exists.
   *
   * It builds a bare object on the prototype and copies a fixed list of base fields onto it, so
   * every field declared here arrives `undefined`. The runtime clones an agent before every run
   * (`agents[agentId].clone()`), which means the omission is not a corner case: without this, the
   * first message anybody sends fails on a `build` that is not a function.
   */
  clone(): RunBuiltAgent {
    const cloned = super.clone() as RunBuiltAgent;
    cloned.whole = this.whole;
    cloned.build = this.build;
    // A clone owns its cancellation state, including while its build is pending.
    cloned.active = undefined;
    return cloned;
  }

  abortRun(): void {
    const active = this.active;
    active?.controller.abort();
    active?.inner?.abortRun();
    super.abortRun();
  }
}

export class UnavailableAgent extends AbstractAgent {
  private reason: string;

  constructor(agent: { id: string; name: string; reason: string }) {
    super({ agentId: agent.id, description: agent.name });
    this.reason = agent.reason;
  }

  clone(): UnavailableAgent {
    const cloned = super.clone() as UnavailableAgent;
    // The runtime clones before running; the base clone only carries base-class fields.
    cloned.reason = this.reason;
    return cloned;
  }

  // Refused here rather than at the endpoint: a deleted coworker has no endpoint worth contacting,
  // and the person is owed the reason rather than a transport error.
  run(): never {
    throw new Error(this.reason);
  }
}

/**
 * The platform client, with one answer corrected.
 *
 * A subclass rather than a wrapper. The runtime is handed this object and calls many methods on it,
 * and the base class keeps its state in `#private` fields. Extending keeps every other method on
 * the instance that owns those fields. The authentication observer separately binds methods to
 * that original instance, so it preserves this override and its private-field receiver.
 *
 * `getThreadMessages` is one override. `handleGetThreadMessages` in the runtime calls it and
 * returns `Response.json` of whatever comes back, so an empty history here is the `{ messages: [] }`
 * the browser expects and a 200 instead of a 500.
 *
 * `getThread`, `getThreadMessages` and `ɵacquireThreadLock` also ask without the base client's
 * print for the one answer each is expected to get (see expected-answers.ts). A conversation is
 * opened before its thread exists, so the browser's history read and Learning's "is this thread
 * new?" both get a 404 on every new conversation, and the base client printed each as
 * `Intelligence platform request failed`. And a Bot's answer to another Bot goes into a
 * conversation whose own run is often still finishing, so its lock is refused with a 409 the hop
 * waits out (handoff-delivery.ts), which printed the same way. The 404 and the 409 are still the
 * client's own `PlatformRequestError` (or, for the history, the empty one), just not printed;
 * every other answer is the base client's to give and to print.
 *
 * `ɵgetClientWsUrl` is corrected too, and only when `browserWsUrl` is given. That address is the one
 * the runtime sends the browser in `/info`, and the browser opens it itself, so it has to be the
 * gateway as the browser can reach it. A server in a container reaches local Intelligence at
 * `host.docker.internal`, which a browser on the host cannot resolve, while the browser's
 * `localhost` is, inside the container, the container. Everything the server opens itself, the
 * runner and channel sockets, stays on `wsUrl`.
 *
 * `browserWsUrl` may be a path, where the server carries the socket on its own address and has no
 * public URL to write before it: the page resolves a path against itself. The runtime also hands the
 * same address to the Recorder in its capture pass, which is not on the page and which the runtime
 * refuses a path for, so a path is made whole on `ownOrigin`, the server's own origin as that caller
 * reached it, whenever the server has one it may name. Either way a `localhost` address is handed out as
 * 127.0.0.1, the only loopback the Recorder opens a ws:// gateway at.
 */
/**
 * IntelligenceKnowingANewThread — adaptador Noma para o toolkit.
 *
 * Antes estendia CopilotKitIntelligence (classe do @copilotkit/runtime/v2).
 * Agora envolve um NomaIntelligenceClient e adiciona os mesmos comportamentos
 * específicos do OpenBot:
 *   - ɵgetClientWsUrl: suporte a URL alternativa do browser + loopback fix.
 *   - getThread: 404 silencioso para thread nova.
 *   - getThreadMessages: retorna [] para thread nova.
 *   - ɵacquireThreadLock: retry com backoff em 409 retryable.
 */
export class IntelligenceKnowingANewThread implements NomaIntelligenceClient {
  readonly #inner: NomaIntelligenceClient;
  readonly #browserClientWsUrl: string | undefined;
  readonly #ownOrigin: (() => string | undefined) | undefined;
  readonly #lockConflictWaitMs: number;

  constructor(
    config: {
      apiUrl: string;
      wsUrl: string;
      apiKey: string;
      browserWsUrl?: string;
      ownOrigin?: () => string | undefined;
      lockConflictWaitMs?: number;
    },
    inner?: NomaIntelligenceClient,
  ) {
    const { browserWsUrl, ownOrigin, lockConflictWaitMs } = config;
    // Aceita uma instância injetada (testes) ou cria uma NomaIntelligence
    // mínima que apenas satisfaz a interface sem dependências de banco.
    this.#inner = inner ?? new _NomaIntelligenceStub(config);
    const browser = browserWsUrl?.trim();
    this.#browserClientWsUrl = browser ? clientSocket(browser) : undefined;
    this.#ownOrigin = ownOrigin;
    this.#lockConflictWaitMs = lockConflictWaitMs ?? LOCK_CONFLICT_WAIT_MS;
  }

  // Delega tudo para o inner, com as overrides abaixo.
  ɵgetApiUrl() { return this.#inner.ɵgetApiUrl(); }
  ɵgetApiKey() { return this.#inner.ɵgetApiKey(); }
  getRuntimeEntitlements() { return this.#inner.getRuntimeEntitlements(); }
  getOrCreateThread(p: Parameters<NomaIntelligenceClient["getOrCreateThread"]>[0]) { return this.#inner.getOrCreateThread(p); }
  ɵrenewThreadLock(p: Parameters<NomaIntelligenceClient["ɵrenewThreadLock"]>[0]) { return this.#inner.ɵrenewThreadLock(p); }
  ɵcleanupThreadLock(p: Parameters<NomaIntelligenceClient["ɵcleanupThreadLock"]>[0]) { return this.#inner.ɵcleanupThreadLock(p); }
  ɵrecordRunStop(p: Parameters<NonNullable<NomaIntelligenceClient["ɵrecordRunStop"]>>[0]) { return this.#inner.ɵrecordRunStop?.(p); }
  listMemories(p: Parameters<NomaIntelligenceClient["listMemories"]>[0]) { return this.#inner.listMemories(p); }
  recallMemories(p: Parameters<NomaIntelligenceClient["recallMemories"]>[0]) { return this.#inner.recallMemories(p); }
  createMemory(p: Parameters<NomaIntelligenceClient["createMemory"]>[0]) { return this.#inner.createMemory(p); }
  updateMemory(p: Parameters<NomaIntelligenceClient["updateMemory"]>[0]) { return this.#inner.updateMemory(p); }
  removeMemory(p: Parameters<NomaIntelligenceClient["removeMemory"]>[0]) { return this.#inner.removeMemory(p); }
  getInspectorMetadata() { return this.#inner.getInspectorMetadata?.() ?? Promise.resolve({ available: false }); }

  ɵgetClientWsUrl(): string {
    const address = this.#browserClientWsUrl ?? this.#inner.ɵgetClientWsUrl();
    if (!address.startsWith("/")) return atLoopbackAddress(address);
    const origin = this.#ownOrigin?.();
    return origin
      ? atLoopbackAddress(`${origin.replace(/^http/, "ws")}${address}`)
      : address;
  }

  /** Thread ou 404 silencioso para thread nova. */
  async getThread(
    params: Parameters<NomaIntelligenceClient["getThread"]>[0],
  ): ReturnType<NomaIntelligenceClient["getThread"]> {
    try {
      return await this.#inner.getThread(params);
    } catch (error) {
      if (
        error instanceof PlatformRequestError &&
        error.status === 404
      ) throw error;
      throw error;
    }
  }

  /** Histórico ou [] para thread nova — sem imprimir o 404. */
  async getThreadMessages(
    params: Parameters<NomaIntelligenceClient["getThreadMessages"]>[0],
  ): ReturnType<NomaIntelligenceClient["getThreadMessages"]> {
    return historyOrEmpty(() => this.#inner.getThreadMessages(params), {
      messages: [],
    });
  }

  /** Lock com retry automático em 409 retryable. */
  async ɵacquireThreadLock(
    params: Parameters<NomaIntelligenceClient["ɵacquireThreadLock"]>[0],
  ): ReturnType<NomaIntelligenceClient["ɵacquireThreadLock"]> {
    const giveUpAt = Date.now() + this.#lockConflictWaitMs;
    let delayMs = LOCK_CONFLICT_RETRY_FIRST_MS;
    for (;;) {
      try {
        return await this.#inner.ɵacquireThreadLock(params);
      } catch (error) {
        const isConflict =
          error instanceof PlatformRequestError && error.status === 409;
        if (!isConflict) throw error;
        const left = giveUpAt - Date.now();
        if (!error.retryable || left <= 0) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(delayMs, left)),
        );
        delayMs = Math.min(delayMs * 2, LOCK_CONFLICT_RETRY_MAX_MS);
      }
    }
  }
}

/**
 * Stub mínimo de NomaIntelligenceClient para quando o toolkit é usado sem
 * injeção explícita (ex.: servidor remoto que não passa a instância).
 * Os métodos de memória/thread delegam ao servidor via fetch, mantendo
 * compatibilidade com o fluxo original do CopilotKit.
 */
class _NomaIntelligenceStub implements NomaIntelligenceClient {
  readonly #apiUrl: string;
  readonly #apiKey: string;
  readonly #wsUrl: string;

  constructor(config: { apiUrl: string; wsUrl: string; apiKey: string }) {
    this.#apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.#apiKey = config.apiKey;
    this.#wsUrl = config.wsUrl;
  }

  ɵgetApiUrl() { return this.#apiUrl; }
  ɵgetApiKey() { return this.#apiKey; }
  ɵgetClientWsUrl() {
    const base = this.#wsUrl.replace(/^http/, "ws").replace(/\/+$/, "");
    return `${base}/client`;
  }

  async #post(path: string, body?: unknown) {
    const res = await fetch(`${this.#apiUrl}${path}`, {
      method: body !== undefined ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new PlatformRequestError(
        `Noma API ${path} responded ${res.status}`,
        res.status,
        res.status >= 500 || res.status === 408 || res.status === 429,
      );
    }
    return res.json() as Promise<Record<string, unknown>>;
  }

  async getRuntimeEntitlements() {
    return this.#post("/api/entitlements/runtime") as Promise<import("@openbot/noma-intelligence/types").RuntimeEntitlementResponse>;
  }
  async getOrCreateThread(p: import("@openbot/noma-intelligence/types").GetOrCreateThreadParams) {
    return this.#post("/api/threads", p) as Promise<import("@openbot/noma-intelligence/types").GetOrCreateThreadResult>;
  }
  async getThread(p: import("@openbot/noma-intelligence/types").GetThreadParams) {
    return this.#post(`/api/threads/${encodeURIComponent(p.threadId)}?userId=${encodeURIComponent(p.userId)}`) as Promise<import("@openbot/noma-intelligence/types").GetThreadResult>;
  }
  async getThreadMessages(p: import("@openbot/noma-intelligence/types").GetThreadMessagesParams) {
    return this.#post(`/api/threads/${encodeURIComponent(p.threadId)}/messages?userId=${encodeURIComponent(p.userId)}`) as Promise<import("@openbot/noma-intelligence/types").GetThreadMessagesResult>;
  }
  async ɵacquireThreadLock(p: import("@openbot/noma-intelligence/types").AcquireThreadLockParams) {
    return this.#post(`/api/threads/${encodeURIComponent(p.threadId)}/lock`, p) as Promise<import("@openbot/noma-intelligence/types").AcquireThreadLockResult>;
  }
  async ɵrenewThreadLock(p: import("@openbot/noma-intelligence/types").RenewThreadLockParams) {
    await this.#post(`/api/threads/${encodeURIComponent(p.threadId)}/lock/renew`, p);
  }
  async ɵcleanupThreadLock(p: import("@openbot/noma-intelligence/types").CleanupThreadLockParams) {
    await this.#post(`/api/threads/${encodeURIComponent(p.threadId)}/lock/release`, p);
  }
  async ɵrecordRunStop(p: import("@openbot/noma-intelligence/types").RecordRunStopParams) {
    if (p.signal?.aborted) return;
    await this.#post("/api/runs/stop", p);
  }
  async listMemories(p: import("@openbot/noma-intelligence/types").ListMemoriesParams) {
    return this.#post("/api/memories", p) as Promise<import("@openbot/noma-intelligence/types").ListMemoriesResult>;
  }
  async recallMemories(p: import("@openbot/noma-intelligence/types").RecallMemoriesParams) {
    return this.#post("/api/memories/recall", p) as Promise<import("@openbot/noma-intelligence/types").RecallMemoriesResult>;
  }
  async createMemory(p: import("@openbot/noma-intelligence/types").CreateMemoryParams) {
    return this.#post("/api/memories/create", p) as Promise<import("@openbot/noma-intelligence/types").CreateMemoryResult>;
  }
  async updateMemory(p: import("@openbot/noma-intelligence/types").UpdateMemoryParams) {
    return this.#post("/api/memories/update", p) as Promise<import("@openbot/noma-intelligence/types").UpdateMemoryResult>;
  }
  async removeMemory(p: import("@openbot/noma-intelligence/types").RemoveMemoryParams) {
    await this.#post("/api/memories/remove", p);
  }
  async getInspectorMetadata() {
    return { available: false };
  }
}

/**
 * How long a lock refused as retryable is asked for again before the refusal is given back.
 *
 * Long enough for the platform to let go of the run before (well under a second when it was seen),
 * short enough that a conversation somebody is genuinely running in is refused about as promptly as
 * before. The first look again is quick, then doubling to the cap.
 */
const LOCK_CONFLICT_WAIT_MS = 5_000;
const LOCK_CONFLICT_RETRY_FIRST_MS = 100;
const LOCK_CONFLICT_RETRY_MAX_MS = 1_000;

/**
 * A gateway address on `localhost` as 127.0.0.1, and any other as it is.
 *
 * The Recorder opens a plain ws:// gateway only at 127.0.0.1 or [::1], never at the name (Decision 21,
 * `isAllowedGatewayUrl` in shared/recorder-api.ts), and refused OpenBot Desktop's `ws://localhost:<port>` after
 * Intelligence had already minted the recording's join token. A local gateway answers on 127.0.0.1 wherever it answers
 * on localhost (Docker publishes its ports there), and the page opens it there as well as it did at the name.
 */
function atLoopbackAddress(wsUrl: string): string {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return wsUrl;
  }
  if (url.hostname !== "localhost") return wsUrl;
  url.hostname = "127.0.0.1";
  return url.toString();
}

/**
 * The gateway's client socket, from any of the three addresses the platform names it by.
 *
 * The rule the runtime applies to `wsUrl` (`deriveClientWsUrl`, which it does not export), so a
 * browser address written the way the server's is lands on the same path.
 */
function clientSocket(wsUrl: string): string {
  const base = wsUrl.replace(/\/$/, "");
  for (const socket of ["/client", "/runner", "/channels"]) {
    if (base.endsWith(socket)) return `${base.slice(0, -socket.length)}/client`;
  }
  return `${base}/client`;
}
