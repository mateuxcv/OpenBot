/**
 * Transporte de telemetria próprio — substitui lambdaClient do @copilotkit/shared.
 *
 * Por padrão é um noop: nenhum dado sai do servidor.
 * Para enviar para seu próprio endpoint, configure OPENBOT_TELEMETRY_URL.
 * Para desligar explicitamente, use OPENBOT_TELEMETRY_DISABLED=1 ou DO_NOT_TRACK=1.
 */

export type TelemetrySendOptions = {
  event: string;
  properties: Record<string, unknown>;
  packageName?: string;
  packageVersion?: string;
  telemetryId?: string;
  licenseToken?: string;
};

function isTelemetryDisabled(env = process.env): boolean {
  return (
    env.DO_NOT_TRACK === "1" ||
    env.DO_NOT_TRACK === "true" ||
    env.OPENBOT_TELEMETRY_DISABLED === "1" ||
    env.OPENBOT_TELEMETRY_DISABLED === "true" ||
    // Mantém compatibilidade com a env var antiga caso alguém já a tenha no .env
    env.COPILOTKIT_TELEMETRY_DISABLED === "1" ||
    env.COPILOTKIT_TELEMETRY_DISABLED === "true"
  );
}

function telemetryUrl(env = process.env): string | undefined {
  return env.OPENBOT_TELEMETRY_URL?.trim() || undefined;
}

/**
 * Envia um evento de telemetria para o endpoint configurado.
 * Se nenhum endpoint estiver configurado, ou se a telemetria estiver desligada,
 * retorna imediatamente sem fazer nada.
 */
export async function sendTelemetryEvent(
  options: TelemetrySendOptions,
  env = process.env,
): Promise<void> {
  if (isTelemetryDisabled(env)) return;
  const url = telemetryUrl(env);
  if (!url) return; // sem endpoint configurado = noop

  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: options.event,
        properties: options.properties,
        package: {
          name: options.packageName ?? "@openbot/server",
          version: options.packageVersion ?? "0.0.0",
        },
        ts: Date.now(),
      }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // Telemetria nunca derruba o servidor.
  }
}

/** Verifica se a telemetria de produto está habilitada (mesma lógica de productExportEnabled). */
export function productTelemetryEnabled(env = process.env): boolean {
  if (isTelemetryDisabled(env)) return false;
  if (env.OPENBOT_PRODUCT_TELEMETRY !== undefined)
    return env.OPENBOT_PRODUCT_TELEMETRY === "1" || env.OPENBOT_PRODUCT_TELEMETRY === "true";
  return env.OPENBOT_DISTRIBUTION === "desktop";
}
