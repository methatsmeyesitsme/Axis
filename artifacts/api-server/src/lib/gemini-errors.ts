// Turns an AI API error into a message worth showing the person, instead
// of a generic "Failed to generate response" for every failure mode.
// Especially useful for free-tier keys that hit daily/rate quotas.

import { getAiProvider, getProviderDisplayName } from "./ai-provider";

export function friendlyAiErrorMessage(
  err: unknown,
  fallback: string = "Failed to generate response",
): string {
  const status = (err as { status?: number; statusCode?: number } | undefined)?.status
    ?? (err as { status?: number; statusCode?: number } | undefined)?.statusCode;
  const message = err instanceof Error ? err.message : String(err);

  const isQuotaError =
    status === 429 ||
    /RESOURCE_EXHAUSTED|quota|rate.?limit|too many requests/i.test(message);

  if (isQuotaError) {
    const provider = getProviderDisplayName();
    if (getAiProvider() === "groq") {
      return `Your Groq API key has hit its usage quota for now. Free-tier keys have daily/per-minute limits — wait a bit and try again.`;
    }
    return `Your ${provider} API key has hit its usage quota for now. Free-tier keys have daily/per-minute limits — wait a bit and try again, or enable Cloud Billing on the Google Cloud project behind this key for higher limits.`;
  }

  return fallback;
}

// Keep the old name as an alias so existing imports don't break immediately
export const friendlyGeminiErrorMessage = friendlyAiErrorMessage;
