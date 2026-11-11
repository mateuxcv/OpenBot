/**
 * Erro de requisição à plataforma — equivalente ao PlatformRequestError do
 * @copilotkit/runtime/v2.
 *
 * Carrega o status HTTP e se a condição é transitória (retryable), pois o
 * OpenBot inspeciona ambos em vários lugares (intelligence-client.ts,
 * intelligence-entitlement-check.ts, thread-history.ts).
 */
export class PlatformRequestError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable = false) {
    super(message);
    this.name = "PlatformRequestError";
    this.status = status;
    this.retryable = retryable;
  }
}
