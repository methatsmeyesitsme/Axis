import { pipeline, type TextGenerationPipeline } from "@huggingface/transformers";

let generator: TextGenerationPipeline | null = null;
let loading: Promise<TextGenerationPipeline> | null = null;
let loadedModelId: string | null = null;

/**
 * Free local models (ONNX / transformers.js).
 *
 * Qwen Coder is a better fit for Axis than the general instruct checkpoint:
 * it uses the same local runtime, but follows code and structured output
 * instructions more reliably. The 0.5B checkpoint is the stable default for
 * Replit's memory budget; use LOCAL_MODEL_SIZE=1.5b on a larger machine.
 */
const MODELS = {
  "0.5b": "onnx-community/Qwen2.5-Coder-0.5B-Instruct",
  "1.5b": "onnx-community/Qwen2.5-Coder-1.5B-Instruct",
} as const;

type LocalModelSize = keyof typeof MODELS;

function getModelSize(): LocalModelSize {
  const raw = (process.env.LOCAL_MODEL_SIZE || "0.5b").toLowerCase().trim();
  if (
    (raw === "1.5b" || raw === "1.5") &&
    process.env.LOCAL_MODEL_ALLOW_LARGE?.toLowerCase().trim() === "true"
  ) {
    return "1.5b";
  }
  return "0.5b";
}

function getModelId(): string {
  return MODELS[getModelSize()];
}

function extractGeneratedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    if (last && typeof last === "object") {
      const content = (last as { content?: unknown }).content;
      if (typeof content === "string") return content;
      const text = (last as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
    return value.map(extractGeneratedText).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    const content = (value as { content?: unknown }).content;
    if (typeof content === "string") return content;
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
    const generatedText = (value as { generated_text?: unknown }).generated_text;
    if (generatedText !== undefined) return extractGeneratedText(generatedText);
  }
  return "";
}

async function getGenerator(): Promise<TextGenerationPipeline> {
  const modelId = getModelId();

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
 * Short, high-signal system prompt for small local models.
 * Focused on coding quality over long instructions.
 */
export function buildLocalSystemPrompt(language: string): string {
  return [
    `You are Axis, an expert ${language} coding assistant.`,
    "Write correct, clean, production-quality code.",
    "When debugging: state the bug, explain why, then show the fixed code.",
    "When generating code: use proper syntax, brief comments, and explain key parts after.",
    "Always put code in markdown fences with the correct language tag.",
    "Be concise and accurate. Prefer working solutions over long explanations.",
  ].join(" ");
}

/**
 * Generate with the local model. Context is kept small so quality stays high.
 */
export async function localGenerate(
  messages: Array<{ role: string; content: string }>,
  options: {
    maxNewTokens?: number;
    maxMessages?: number;
    maxCharsPerMessage?: number;
  } = {},
): Promise<string> {
  const pipe = await getGenerator();
  const size = getModelSize();

  // Slightly more room for the 1.5B model
  const maxMessages = options.maxMessages ?? (size === "1.5b" ? 8 : 4);
  const maxChars = options.maxCharsPerMessage ?? (size === "1.5b" ? 1600 : 1000);
  const defaultTokens = size === "1.5b" ? 1024 : 384;

  const trimmed = messages.slice(-maxMessages).map((m) => ({
    role: m.role,
    content: String(m.content).slice(0, maxChars),
  }));

  const result = await pipe(trimmed, {
    max_new_tokens: options.maxNewTokens ?? defaultTokens,
    do_sample: false,
    temperature: 0.15,
  });

  const raw = Array.isArray(result) ? result[0] : result;
  const generated = extractGeneratedText(
    (raw as { generated_text?: unknown })?.generated_text ?? raw,
  );
  const parts = generated.split(/(?:^|\n)assistant\s*/i);
  const last = parts[parts.length - 1]?.trim();
  return last || generated.trim();
}

export const LOCAL_MODEL_ID = getModelId();
export { getModelSize };
