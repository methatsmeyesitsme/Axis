import { GoogleGenAI, Modality } from "@google/genai";

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  if (client) return client;

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

export const ai = {
  get models() {
    return getClient().models;
  },
} as Pick<GoogleGenAI, "models">;

export async function generateImage(
  prompt: string
): Promise<{ b64_json: string; mimeType: string }> {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
    },
  });

  const candidate = response.candidates?.[0];
  const imagePart = candidate?.content?.parts?.find(
    (part: { inlineData?: { data?: string; mimeType?: string } }) => part.inlineData
  );

  if (!imagePart?.inlineData?.data) {
    throw new Error("No image data in response");
  }

  return {
    b64_json: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || "image/png",
  };
}
