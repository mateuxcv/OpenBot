/**
 * Whether this failure means "the platform has never heard of that thread".
 *
 * Com Noma Intelligence, o store local lança PlatformRequestError com status 404
 * quando o thread não existe — mesmo comportamento que o CopilotKit original.
 */
export function isMissingThread(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "PlatformRequestError" &&
    (error as { status?: unknown }).status === 404
  );
}

/**
 * Read a thread's history, treating a thread the platform does not know about as having none.
 *
 * Takes the read as a function rather than being folded into `IntelligenceKnowingANewThread` in
 * copilot.ts, so the decision can be exercised against a function that really throws. The previous
 * attempt at this fix (#71) was tested by re-implementing its middleware inside the test file, which
 * passes with the real code deleted; this is the actual code path in both places.
 */
export async function historyOrEmpty<T>(
  read: () => Promise<T>,
  whenMissing: T,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isMissingThread(error)) return whenMissing;
    throw error;
  }
}
