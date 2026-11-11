/**
 * Teste de integração: Gemma 3 27B via Amazon Bedrock + noma-runtime.
 *
 * Uso: bun run scripts/test-bedrock-gemma.ts
 *
 * Verifica:
 * 1. resolveModel cria o cliente Bedrock corretamente
 * 2. BuiltInAgent chama o modelo e recebe eventos AG-UI
 * 3. O stream de texto funciona de ponta a ponta
 */

// Carrega as variáveis de ambiente AWS do sistema
// (AWS_ACCESS_KEY, AWS_SECRET_KEY, AWS_REGION, AWS_BEARER_TOKEN_BEDROCK)

import { resolveModel, BuiltInAgent } from "../noma-runtime/src/index.ts";

const MODEL_SPEC = "bedrock/google.gemma-3-27b-it";

async function main() {
  console.log(`\n🚀 Testando ${MODEL_SPEC} via noma-runtime\n`);

  // 1. Resolve o modelo
  console.log("1. Resolvendo modelo...");
  const model = resolveModel(MODEL_SPEC);
  console.log("   ✅ Modelo resolvido:", model.modelId ?? "(sem modelId)");

  // 2. Cria o agente
  const agent = new BuiltInAgent({
    model,
    prompt: "Você é um assistente útil e conciso.",
    maxSteps: 1,
  });

  // 3. Executa uma pergunta simples
  const pergunta = "Em uma frase, qual é a capital do Brasil?";
  console.log(`\n2. Perguntando: "${pergunta}"`);
  console.log("   Eventos recebidos:");

  const events: string[] = [];

  await new Promise<void>((resolve, reject) => {
    agent.run({
      threadId: "test-thread-001",
      runId: "test-run-001",
      messages: [{ id: "msg-1", role: "user", content: pergunta }],
      tools: [],
      context: [],
      forwardedProps: {},
    }).subscribe({
      next(event) {
        const type = (event as { type: string }).type;
        events.push(type);

        if (type === "TEXT_MESSAGE_CHUNK") {
          const chunk = event as { delta?: string };
          process.stdout.write(chunk.delta ?? "");
        }
      },
      error(err) {
        console.error("\n   ❌ Erro:", err instanceof Error ? err.message : err);
        reject(err);
      },
      complete() {
        resolve();
      },
    });
  });

  console.log("\n\n3. Eventos recebidos:", events.join(" → "));

  const success =
    events.includes("RUN_STARTED") &&
    events.includes("TEXT_MESSAGE_START") &&
    events.includes("TEXT_MESSAGE_CHUNK") &&
    events.includes("TEXT_MESSAGE_END") &&
    events.includes("RUN_FINISHED");

  if (success) {
    console.log("\n✅ TESTE PASSOU — BuiltInAgent + Bedrock funcionando corretamente.\n");
    process.exit(0);
  } else {
    console.error("\n❌ TESTE FALHOU — sequência de eventos inesperada.");
    console.error("   Esperado: RUN_STARTED → TEXT_MESSAGE_START → TEXT_MESSAGE_CHUNK → TEXT_MESSAGE_END → RUN_FINISHED");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Erro fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
