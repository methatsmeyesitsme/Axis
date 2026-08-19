import { GoogleGenAI } from "@google/genai";

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  if (client) return client;

  // Prefer Replit's hosted AI-integration credentials if present (these route
  // through Replit's proxy, hence the custom baseUrl/apiVersion). Otherwise
  // fall back to a personal Google AI Studio key, which talks to Google's
  // real endpoint directly and needs no baseUrl override at all.
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey =
    process.env.AI_INTEGRATIONS_GEMINI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error(
      "No Gemini API key found. Set AI_INTEGRATIONS_GEMINI_API_KEY (Replit's AI integration) or GEMINI_API_KEY (a personal Google AI Studio key) as a secret.",
    );
  }

  client = new GoogleGenAI(
    baseUrl ? { apiKey, httpOptions: { apiVersion: "", baseUrl } } : { apiKey },
  );
  return client;
}

// Keep the existing ai.models API for callers, but defer configuration errors
// until an AI handler is actually used. Other API routes (such as GitHub OAuth)
// should not be taken down because an optional AI integration is unavailable.
export const ai = {
  get models() {
    return getClient().models;
  },
} as Pick<GoogleGenAI, "models">;
