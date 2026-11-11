/**
 * Entitlements Noma — sem licença proprietária.
 *
 * O OpenBot consulta entitlements para saber se memória e learning estão
 * disponíveis. Noma responde sempre "ready + active + tudo habilitado" porque
 * não há licença a verificar — é infraestrutura própria.
 *
 * A função createNomaEntitlements() retorna um objeto cujo método
 * getRuntimeEntitlements() é chamado em:
 *   - server/src/intelligence-entitlement-check.ts (boot check)
 *   - server/src/self-host-banner.ts (banner de auto-hospedagem)
 *   - server/src/memory/intelligence.ts (guarda de memória)
 */

import type { RuntimeEntitlementResponse } from "./types";

const ALWAYS_ACTIVE: RuntimeEntitlementResponse = {
  status: "ready",
  entitlement: {
    active: true,
    // "team_self_hosted" faz paysForIntelligence() retornar true →
    // esconde o banner de self-hosting corretamente.
    planCode: "team_self_hosted",
    source: "noma",
    features: {
      memory: true,
      learning: true,
    },
  },
};

export function createNomaEntitlements() {
  return {
    async getRuntimeEntitlements(): Promise<RuntimeEntitlementResponse> {
      return ALWAYS_ACTIVE;
    },
  };
}
