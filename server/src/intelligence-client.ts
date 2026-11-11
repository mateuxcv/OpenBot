import {
  PlatformRequestError,
  type NomaIntelligenceClient,
} from "@openbot/noma-intelligence/factory";
import { IntelligenceKnowingANewThread } from "@openbot/toolkit/copilotkit/agents";
import type { IntelligenceSettings } from "./config";
import {
  clearDesktopConnectionFailure,
  recordDesktopConnectionFailure,
} from "./desktop-connection-failure";
import { transientStatus } from "./intelligence-startup";

/**
 * O status HTTP que a Noma responde ao entitlement check, pedido sem o cliente
 * de runtime (que imprimiria todo falha no console antes de lançar).
 *
 * Noma responde sempre 200 — não há licença proprietária a verificar.
 * A função ainda existe para manter o mesmo fluxo de boot que o OpenBot original
 * usava com o CopilotKit Intelligence.
 */
function quietUntilAnswered(client: NomaIntelligenceClient) {
  let answered = false;
  let asking: Promise<void> | undefined;
  const ask = async () => {
    let status: number;
    try {
      status = await runtimeEntitlementStatus({
        apiUrl: client.ɵgetApiUrl(),
        apiKey: client.ɵgetApiKey(),
      });
    } catch (error) {
      throw new PlatformRequestError(
        error instanceof Error ? error.message : String(error),
        502,
        true,
      );
    }
    if (status !== 200)
      throw new PlatformRequestError(
        `Runtime entitlement request failed with status ${status}`,
        status,
        transientStatus(status),
      );
    answered = true;
  };
  return async (read: () => unknown): Promise<unknown> => {
    if (!answered) {
      asking ??= ask().finally(() => {
        asking = undefined;
      });
      await asking;
    }
    return read();
  };
}

/** Observa erros de autenticação antes que handlers genéricos os transformem em 500. */
export function observeIntelligenceAuthentication<
  T extends NomaIntelligenceClient,
>(client: T): T {
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const quiet = quietUntilAnswered(client);
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function" || property === "constructor")
        return value;
      const cached = methods.get(property);
      if (cached) return cached;
      const observed = (...args: unknown[]): unknown => {
        const result: unknown =
          property === "getRuntimeEntitlements"
            ? quiet(() => Reflect.apply(value, target, args))
            : Reflect.apply(value, target, args);
        if (!(result instanceof Promise)) return result;
        return result.then(
          (response: unknown) => {
            if (
              property !== "getRuntimeEntitlements" &&
              property !== "getInspectorMetadata"
            ) {
              clearDesktopConnectionFailure("intelligence");
            }
            return response;
          },
          (error: unknown) => {
            if (
              error instanceof Error &&
              "status" in error &&
              (error as { status?: unknown }).status === 401
            ) {
              recordDesktopConnectionFailure({
                connection: "intelligence",
                code: "intelligence_authentication_failed",
              });
            }
            throw error;
          },
        );
      };
      methods.set(property, observed);
      return observed;
    },
  });
}

/**
 * Status HTTP do entitlement endpoint.
 *
 * Com Noma, o endpoint local responde sempre 200. A função é mantida para
 * não quebrar o fluxo de boot (intelligence-entitlement-check.ts usa este status
 * para decidir se Intelligence ainda está iniciando).
 */
export async function runtimeEntitlementStatus(
  settings: Pick<IntelligenceSettings, "apiUrl" | "apiKey">,
  timeoutMs = 5_000,
): Promise<number> {
  let response: Response;
  try {
    response = await fetch(
      `${settings.apiUrl.trim().replace(/\/+$/, "")}/api/entitlements/runtime`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${settings.apiKey}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (error) {
    throw Object.assign(
      new Error(
        `The backend did not answer (${error instanceof Error ? error.message : String(error)})`,
      ),
      { retryable: true },
    );
  }
  await response.body?.cancel().catch(() => {});
  if (response.status === 401) {
    recordDesktopConnectionFailure({
      connection: "intelligence",
      code: "intelligence_authentication_failed",
    });
  }
  return response.status;
}

/**
 * Instância do cliente Noma para consultas fora de um run (ex.: verificar
 * se um thread ainda existe).
 *
 * Recebe a instância global de NomaIntelligence (criada em index.ts) em vez
 * de construir uma nova — Noma não tem custo de socket como o CopilotKit, mas
 * manter uma única instância simplifica testes e evita state duplicado.
 */
export function createIntelligenceClient(
  settings: IntelligenceSettings,
): NomaIntelligenceClient {
  return observeIntelligenceAuthentication(
    new IntelligenceKnowingANewThread({
      apiUrl: settings.apiUrl,
      wsUrl: settings.gatewayWsUrl,
      apiKey: settings.apiKey,
    }),
  );
}
