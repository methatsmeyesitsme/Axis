/**
 * Backend-only AI provider switch.
 * Users cannot change this — only you (via env var / secrets).
 *
 * Current default: local (free on-device Qwen)
 *
 * Force a provider with:
 *   AXIS_AI_PROVIDER=local | groq | gemini
 *
 * Local model size:
 *   LOCAL_MODEL_SIZE=1.5b   (default, smarter)
 *   LOCAL_MODEL_SIZE=0.5b   (lighter, if memory is tight)
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

  // Default to local (free, on-device) as requested
  return "local";
}

export function getProviderDisplayName(provider: AiProvider = getAiProvider()): string {
  switch (provider) {
    case "groq":
      return "Groq";
    case "local":
      return "Local (Qwen)";
    default:
      return "Gemini";
  }
}
