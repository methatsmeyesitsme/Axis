import { GoogleGenAI } from "@google/genai";

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  if (client) return client;
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  if (!baseUrl) {
    throw new Error(
      "AI_INTEGRATIONS_GEMINI_BASE_URL must be set. Did you forget to provision the Gemini AI integration?",
    );
  }
  if (!apiKey) {
    throw new Error(
      "AI_INTEGRATIONS_GEMINI_API_KEY must be set. Did you forget to provision the Gemini AI integration?",
    );
  }
  client = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "", baseUrl },
  });
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
