/**
 * Gateway WebSocket Noma — servidor Phoenix-protocol.
 *
 * O CopilotKit Intelligence usa o protocolo de mensagens Phoenix (Elixir) para
 * streaming em tempo real entre browser e agente. Este módulo implementa um
 * servidor WebSocket que fala esse mesmo protocolo, sem depender do framework
 * Phoenix nem de Elixir.
 *
 * Protocolo Phoenix (v2 JSON):
 *   [join_ref, ref, topic, event, payload]
 *
 * Eventos do protocolo:
 *   phx_join    — cliente entra num tópico
 *   phx_leave   — cliente sai do tópico
 *   phx_reply   — servidor responde
 *   phx_error   — servidor sinaliza erro
 *   phx_close   — servidor fecha o tópico
 *   heartbeat   — keep-alive (tópico "phoenix")
 *
 * Arquitetura:
 *   - Cada conexão WebSocket é um `PhoenixSocket`.
 *   - Cada `phx_join` cria um `PhoenixChannel` vinculado a um tópico.
 *   - O roteador de tópicos (`TopicRouter`) despacha mensagens para handlers.
 *   - OpenBot usa o tópico "conversation:<threadId>" para streaming AG-UI.
 */

// ---------------------------------------------------------------------------
// Tipos do protocolo Phoenix
// ---------------------------------------------------------------------------

/** Uma mensagem Phoenix serializada como array JSON de 5 elementos. */
export type PhoenixMessage = [
  join_ref: string | null,
  ref: string | null,
  topic: string,
  event: string,
  payload: Record<string, unknown>,
];

export function parsePhoenixMessage(raw: string): PhoenixMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 5 &&
      (parsed[0] === null || typeof parsed[0] === "string") &&
      (parsed[1] === null || typeof parsed[1] === "string") &&
      typeof parsed[2] === "string" &&
      typeof parsed[3] === "string" &&
      parsed[4] !== null &&
      typeof parsed[4] === "object"
    ) {
      return parsed as PhoenixMessage;
    }
    return null;
  } catch {
    return null;
  }
}

export function serializePhoenixMessage(msg: PhoenixMessage): string {
  return JSON.stringify(msg);
}

// ---------------------------------------------------------------------------
// Tipos do servidor
// ---------------------------------------------------------------------------

/** O que o gateway precisa enviar de volta ao cliente. */
export interface PhoenixSocketSender {
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

/** Handler de um tópico específico. */
export interface TopicHandler {
  /** Chamado quando o cliente faz phx_join. Responde ok/error. */
  onJoin(
    socket: PhoenixSocketSender,
    joinRef: string | null,
    ref: string | null,
    topic: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true; response?: Record<string, unknown> } | { ok: false; reason: string }>;

  /** Chamado para cada evento depois do join. */
  onMessage(
    socket: PhoenixSocketSender,
    joinRef: string | null,
    ref: string | null,
    topic: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void>;

  /** Chamado quando o cliente faz phx_leave ou a conexão fecha. */
  onLeave(topic: string, reason: "leave" | "close" | "error"): Promise<void>;
}

// ---------------------------------------------------------------------------
// Roteador de tópicos
// ---------------------------------------------------------------------------

type TopicPattern = string | RegExp;

type TopicRegistration = {
  pattern: TopicPattern;
  factory: (topic: string) => TopicHandler;
};

export class TopicRouter {
  private registrations: TopicRegistration[] = [];

  /** Registra um handler para um padrão de tópico. */
  register(pattern: TopicPattern, factory: (topic: string) => TopicHandler): this {
    this.registrations.push({ pattern, factory });
    return this;
  }

  resolve(topic: string): TopicHandler | null {
    for (const reg of this.registrations) {
      if (typeof reg.pattern === "string") {
        if (topic === reg.pattern || topic.startsWith(`${reg.pattern}:`)) {
          return reg.factory(topic);
        }
      } else if (reg.pattern.test(topic)) {
        return reg.factory(topic);
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Conexão WebSocket Phoenix
// ---------------------------------------------------------------------------

/**
 * Gerencia uma conexão WebSocket, roteando mensagens Phoenix para os handlers
 * de tópico corretos.
 */
export class PhoenixConnection {
  private channels = new Map<string, { handler: TopicHandler; joinRef: string | null }>();
  private readonly router: TopicRouter;
  private readonly socket: PhoenixSocketSender;

  constructor(socket: PhoenixSocketSender, router: TopicRouter) {
    this.socket = socket;
    this.router = router;
  }

  async onMessage(raw: string): Promise<void> {
    const msg = parsePhoenixMessage(raw);
    if (!msg) return;

    const [joinRef, ref, topic, event, payload] = msg;

    // Heartbeat: responde imediatamente sem envolver handlers de tópico.
    if (topic === "phoenix" && event === "heartbeat") {
      this.reply(null, ref, "phoenix", "phx_reply", { status: "ok", response: {} });
      return;
    }

    if (event === "phx_join") {
      await this.handleJoin(joinRef, ref, topic, payload);
      return;
    }

    if (event === "phx_leave") {
      await this.handleLeave(joinRef, ref, topic);
      return;
    }

    const channel = this.channels.get(topic);
    if (!channel) {
      this.reply(joinRef, ref, topic, "phx_reply", {
        status: "error",
        response: { reason: "unmatched topic" },
      });
      return;
    }

    await channel.handler
      .onMessage(this.socket, joinRef, ref, topic, event, payload)
      .catch(() => {});
  }

  async onClose(): Promise<void> {
    for (const [topic, channel] of this.channels) {
      await channel.handler.onLeave(topic, "close").catch(() => {});
    }
    this.channels.clear();
  }

  // ---------------------------------------------------------------------------
  // Helpers privados
  // ---------------------------------------------------------------------------

  private reply(
    joinRef: string | null,
    ref: string | null,
    topic: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    this.socket.send(
      serializePhoenixMessage([joinRef, ref, topic, event, payload]),
    );
  }

  private async handleJoin(
    joinRef: string | null,
    ref: string | null,
    topic: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Não permite join duplo no mesmo tópico sem leave anterior.
    if (this.channels.has(topic)) {
      this.reply(joinRef, ref, topic, "phx_reply", {
        status: "error",
        response: { reason: "already joined" },
      });
      return;
    }

    const handler = this.router.resolve(topic);
    if (!handler) {
      this.reply(joinRef, ref, topic, "phx_reply", {
        status: "error",
        response: { reason: "unmatched topic" },
      });
      return;
    }

    const result = await handler
      .onJoin(this.socket, joinRef, ref, topic, payload)
      .catch((err: unknown) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : "internal error",
      }));

    if (result.ok) {
      this.channels.set(topic, { handler, joinRef });
      this.reply(joinRef, ref, topic, "phx_reply", {
        status: "ok",
        response: result.response ?? {},
      });
    } else {
      this.reply(joinRef, ref, topic, "phx_reply", {
        status: "error",
        response: { reason: result.reason },
      });
    }
  }

  private async handleLeave(
    joinRef: string | null,
    ref: string | null,
    topic: string,
  ): Promise<void> {
    const channel = this.channels.get(topic);
    if (channel) {
      await channel.handler.onLeave(topic, "leave").catch(() => {});
      this.channels.delete(topic);
    }
    this.reply(joinRef, ref, topic, "phx_reply", {
      status: "ok",
      response: {},
    });
  }
}

// ---------------------------------------------------------------------------
// Handler do tópico de conversa ("conversation:<threadId>")
// ---------------------------------------------------------------------------

/**
 * Streams AG-UI via Phoenix para um thread específico.
 *
 * O browser se junta a "conversation:<threadId>" e recebe eventos AG-UI
 * publicados pelo runner. O runner publica via `ConversationBroadcaster`.
 */
export type AgUiEvent = Record<string, unknown>;

export type ConversationSubscriber = {
  id: string;
  onEvent(event: AgUiEvent): void;
  onClose(): void;
};

/** Registry de subscribers por threadId — compartilhado entre connections. */
export class ConversationBroadcaster {
  private subscribers = new Map<string, Map<string, ConversationSubscriber>>();

  subscribe(threadId: string, subscriber: ConversationSubscriber): () => void {
    let group = this.subscribers.get(threadId);
    if (!group) {
      group = new Map();
      this.subscribers.set(threadId, group);
    }
    group.set(subscriber.id, subscriber);
    return () => {
      group?.delete(subscriber.id);
      if (group?.size === 0) this.subscribers.delete(threadId);
    };
  }

  broadcast(threadId: string, event: AgUiEvent): void {
    const group = this.subscribers.get(threadId);
    if (!group) return;
    for (const subscriber of group.values()) {
      try {
        subscriber.onEvent(event);
      } catch {
        // Um subscriber com erro não derruba os demais.
      }
    }
  }

  close(threadId: string): void {
    const group = this.subscribers.get(threadId);
    if (!group) return;
    for (const subscriber of group.values()) {
      try {
        subscriber.onClose();
      } catch {}
    }
    this.subscribers.delete(threadId);
  }
}

export function createConversationTopicHandler(
  broadcaster: ConversationBroadcaster,
): (topic: string) => TopicHandler {
  return (topic: string) => {
    const threadId = topic.replace(/^conversation:/, "");
    let unsubscribe: (() => void) | undefined;
    let socketRef: PhoenixSocketSender | undefined;
    let joinRefRef: string | null = null;

    return {
      async onJoin(socket, joinRef, _ref, _topic, _payload) {
        socketRef = socket;
        joinRefRef = joinRef;
        unsubscribe = broadcaster.subscribe(threadId, {
          id: `${threadId}-${joinRef ?? "anon"}`,
          onEvent(event) {
            socket.send(
              serializePhoenixMessage([
                joinRef,
                null,
                topic,
                "ag_ui_event",
                event,
              ]),
            );
          },
          onClose() {
            socket.send(
              serializePhoenixMessage([joinRef, null, topic, "phx_close", {}]),
            );
          },
        });
        return { ok: true };
      },

      async onMessage(_socket, _joinRef, _ref, _topic, _event, _payload) {
        // O browser não envia mensagens de conteúdo neste tópico; apenas observa.
      },

      async onLeave(_topic, _reason) {
        unsubscribe?.();
        unsubscribe = undefined;
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Fábrica principal do gateway
// ---------------------------------------------------------------------------

/**
 * Cria o roteador pronto para uso pelo servidor Hono/Bun.
 *
 * Uso:
 *   const { router, broadcaster } = createNomaGateway();
 *   // No handler de WebSocket do Bun:
 *   const conn = new PhoenixConnection(socket, router);
 *   socket.onmessage = (e) => conn.onMessage(e.data);
 *   socket.onclose = () => conn.onClose();
 */
export function createNomaGateway(): {
  router: TopicRouter;
  broadcaster: ConversationBroadcaster;
} {
  const broadcaster = new ConversationBroadcaster();
  const router = new TopicRouter();
  router.register(/^conversation:/, createConversationTopicHandler(broadcaster));
  return { router, broadcaster };
}
