/**
 * Backend-only AI provider switch.
 * Users cannot change this — only you (via env var / secrets).
 *
 * Priority (highest → lowest):
 *   1. Groq   (if GROQ_API_KEY is set or AXIS_AI_PROVIDER=groq)
 *   2. Gemini (if a Gemini key is set or AXIS_AI_PROVIDER=gemini)
 *   3. Local  (Qwen2.5-0.5B on-device) — last-resort backup only
 *
 * Force a provider with:
 *   AXIS_AI_PROVIDER=groq | gemini | local
 */

export type AiProvider = "groq" | "gemini" | "local";

function hasGeminiKey(): boolean {
  return !!(process.env.AI_INTEGRATIONS_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

export function getAiProvider(): AiProvider {
  const forced = process.env.AXIS_AI_PROVIDER?.toLowerCase().trim();

  if (forced === "groq" || forced === "gemini" || forced === "local") {
    return forced;
  }

  // Auto priority
  if (process.env.GROQ_API_KEY) return "groq";
  if (hasGeminiKey()) return "gemini";
  return "local";
}

export function getProviderDisplayName(provider: AiProvider = getAiProvider()): string {
  switch (provider) {
    case "groq":
      return "Groq";
    case "local":
      return "Local (Qwen 0.5B)";
    default:
      return "Gemini";
  }
}
