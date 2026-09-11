/**
 * Backend-only AI provider switch.
 *
 * MAIN PROVIDER = local (free on-device Qwen)
 * Cloud providers only run when you explicitly force them.
 *
 *   AXIS_AI_PROVIDER=local   → local (default)
 *   AXIS_AI_PROVIDER=groq    → Groq (needs GROQ_API_KEY)
 *   AXIS_AI_PROVIDER=gemini  → Gemini (needs a Gemini key)
 *
 * Local model size:
 *   LOCAL_MODEL_SIZE=1.5b   (default, smarter)
 *   LOCAL_MODEL_SIZE=0.5b   (lighter)
 */

export type AiProvider = "groq" | "gemini" | "local";

export function getAiProvider(): AiProvider {
  const forced = process.env.AXIS_AI_PROVIDER?.toLowerCase().trim();

  // Only leave local when explicitly requested
  if (forced === "groq") return "groq";
  if (forced === "gemini") return "gemini";

  // Everything else (including unset) → local
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
