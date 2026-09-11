import { pipeline, type TextGenerationPipeline } from "@huggingface/transformers";

let generator: TextGenerationPipeline | null = null;
let loading: Promise<TextGenerationPipeline> | null = null;

const MODEL_ID = "onnx-community/Qwen2.5-0.5B-Instruct";

async function getGenerator(): Promise<TextGenerationPipeline> {
  if (generator) return generator;

  if (!loading) {
    loading = (async () => {
      console.log("[local-ai] Loading Qwen2.5-0.5B-Instruct (this can take a while on first run)...");
      const t0 = Date.now();
      const pipe = await pipeline("text-generation", MODEL_ID, {
        dtype: "q4",
        device: "cpu",
      });
      console.log(`[local-ai] Model loaded in ${Date.now() - t0}ms`);
      generator = pipe as TextGenerationPipeline;
      return generator;
    })();
  }

  return loading;
}

/**
 * Very small local model intended only as a last-resort backup
 * when Groq and Gemini are unavailable.
 * Quality is limited — do not expect strong coding performance.
 */
export async function localGenerate(
  messages: Array<{ role: string; content: string }>,
  options: { maxNewTokens?: number } = {},
): Promise<string> {
  const pipe = await getGenerator();

  const result = await pipe(messages, {
    max_new_tokens: options.maxNewTokens ?? 256,
    do_sample: false,
    temperature: 0.1,
  });

  // Transformers.js returns different shapes depending on version;
  // normalize to a plain string.
  const raw = Array.isArray(result) ? result[0] : result;
  const generated =
    (raw as any)?.generated_text ??
    (raw as any)?.[0]?.generated_text ??
    (typeof raw === "string" ? raw : JSON.stringify(raw));

  if (typeof generated === "string") {
    // When chat template is used, the full conversation is often returned.
    // Try to extract only the assistant's last reply.
    const lastAssistant = generated.split(/assistant\s*/i).pop()?.trim();
    return lastAssistant || generated.trim();
  }

  return String(generated);
}

export const LOCAL_MODEL_ID = MODEL_ID;
