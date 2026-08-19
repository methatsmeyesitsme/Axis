// Turns a Gemini API error into a message worth showing the person, instead
// of a generic "Failed to generate response" for every failure mode. The
// case this specifically exists for: free-tier API keys hit a daily/rate
// quota (HTTP 429, RESOURCE_EXHAUSTED) fairly easily, and that's a very
// different, actionable situation from an actual bug — the person should
// know to wait for the quota to reset or enable billing, not assume
// something is broken.
export function friendlyGeminiErrorMessage(
  err: unknown,
  fallback: string = "Failed to generate response",
): string {
  const status = (err as { status?: number } | undefined)?.status;
  const message = err instanceof Error ? err.message : String(err);

  const isQuotaError =
    status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(message);

  if (isQuotaError) {
    return "Your Gemini API key has hit its usage quota for now. Free-tier keys have daily/per-minute limits — wait a bit and try again, or enable Cloud Billing on the Google Cloud project behind this key for higher limits.";
  }

  return fallback;
}
