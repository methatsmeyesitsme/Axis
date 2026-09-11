import { pipeline, type TextGenerationPipeline } from "@huggingface/transformers";

let generator: TextGenerationPipeline | null = null;
let loading: Promise<TextGenerationPipeline> | null = null;
let loadedModelId: string | null = null;

/**
 * Free local models (ONNX, transformers.js compatible)
 * - 0.5B: lightest, safest for low-memory environments (default)
 * - 1.5B: noticeably smarter, needs more RAM
 */
const MODELS = {
  "0.5b": "onnx-community/Qwen2.5-0.5B-Instruct",
  "1.5b": "onnx-community/Qwen2.5-1.5B-Instruct",
} as const;

type LocalModelSize = keyof typeof MODELS;

function getModelSize(): LocalModelSize {
  const raw = (process.env.LOCAL_MODEL_SIZE || "0.5b").toLowerCase().trim();
  if (raw === "1.5b" || raw === "1.5") return "1.5b";
  return "0.5b";
}

function getModelId(): string {
  return MODELS[getModelSize()];
}

async function getGenerator(): Promise<TextGenerationPipeline> {
  const modelId = getModelId();

  // Reload if the desired model changed
  if (generator && loadedModelId === modelId) return generator;

  if (!loading || loadedModelId !== modelId) {
    loading = (async () => {
      console.log(`[local-ai] Loading ${modelId} (first run can take a while)...`);
      const t0 = Date.now();
      const pipe = await pipeline("text-generation", modelId, {
        dtype: "q4",
        device: "cpu",
      });
      console.log(`[local-ai] Model loaded in ${Date.now() - t0}ms`);
      generator = pipe as TextGenerationPipeline;
      loadedModelId = modelId;
      return generator;
    })();
  }

  return loading;
}

/**
 * Short, forceful system prompt tuned for tiny local models.
 * Small models get confused by long instructions — keep this tight.
 */
export function buildLocalSystemPrompt(language: string): string {
  return [
    `You are Axis, a helpful coding assistant specializing in ${language}.`,
    "Be clear, concise, and practical.",
    "When writing code: use correct syntax, add brief comments, and explain key parts.",
    "When debugging: identify the bug, explain why, then show the fixed code.",
    "Always use markdown code blocks with the correct language tag.",
    "Keep answers focused. Do not ramble.",
  ].join(" ");
}

/**
 * Generate a reply with the local model.
 * Context is intentionally kept small so the model stays coherent.
 */
export async function localGenerate(
  messages: Array<{ role: string; content: string }>,
  options: { maxNewTokens?: number } = {},
): Promise<string> {
  const pipe = await getGenerator();

  // Hard limit context — tiny models degrade fast with long history
  const maxMessages = getModelSize() === "1.5b" ? 6 : 4;
  const trimmed = messages.slice(-maxMessages).map((m) => ({
    role: m.role,
    content: String(m.content).slice(0, 1200),
  }));

  const result = await pipe(trimmed, {
    max_new_tokens: options.maxNewTokens ?? (getModelSize() === "1.5b" ? 768 : 384),
    do_sample: false,
    temperature: 0.2,
  });

  const raw = Array.isArray(result) ? result[0] : result;
  const generated =
    (raw as any)?.generated_text ??
    (raw as any)?.[0]?.generated_text ??
    (typeof raw === "string" ? raw : JSON.stringify(raw));

  if (typeof generated === "string") {
    // Prefer the last assistant turn if the full chat was returned
    const parts = generated.split(/(?:^|\n)assistant\s*/i);
    const last = parts[parts.length - 1]?.trim();
    if (last && last.length > 0) return last;
    return generated.trim();
  }

  return String(generated);
}

export const LOCAL_MODEL_ID = getModelId();
export { getModelSize };
