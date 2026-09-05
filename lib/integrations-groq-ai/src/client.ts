import OpenAI from "openai";

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (client) return client;

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error(
      "No Groq API key found. Set GROQ_API_KEY as a secret (get a free key at https://console.groq.com).",
    );
  }

  client = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });

  return client;
}

/**
 * Groq client (OpenAI-compatible).
 * Default model: llama-3.3-70b-versatile (good balance of quality + free-tier limits)
 * Faster/cheaper alternative: llama-3.1-8b-instant
 */
export const groq = {
  get chat() {
    return getClient().chat;
  },
  get models() {
    return getClient().models;
  },
};

export const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";
export const GROQ_FAST_MODEL = "llama-3.1-8b-instant";
