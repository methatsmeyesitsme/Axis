/**
 * Backend-only AI provider switch.
 * Users cannot change this — only you (via env var / secrets).
 *
 * How to switch:
 *   AXIS_AI_PROVIDER=groq     → force Groq
 *   AXIS_AI_PROVIDER=gemini   → force Gemini
 *
 * If AXIS_AI_PROVIDER is not set:
 *   - Uses Groq when GROQ_API_KEY is present
 *   - Otherwise falls back to Gemini
 */

export type AiProvider = "groq" | "gemini";

export function getAiProvider(): AiProvider {
  const forced = process.env.AXIS_AI_PROVIDER?.toLowerCase().trim();

  if (forced === "groq" || forced === "gemini") {
    return forced;
  }

  // Auto-detect: prefer Groq when a key is available
  if (process.env.GROQ_API_KEY) {
    return "groq";
  }

  return "gemini";
}

export function getProviderDisplayName(provider: AiProvider = getAiProvider()): string {
  return provider === "groq" ? "Groq" : "Gemini";
}
