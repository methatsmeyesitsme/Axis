import { pipeline, type TextGenerationPipeline } from "@huggingface/transformers";

let generator: TextGenerationPipeline | null = null;
let loading: Promise<TextGenerationPipeline> | null = null;
let loadedModelId: string | null = null;

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

function stripAssistantPrefix(generated: string): string {
  const parts = generated.split(/(?:^|\n)assistant\s*/i);
  const last = parts[parts.length - 1]?.trim();
  return last || generated.trim();
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

/** Warm the model at server start so the first chat is faster. */
export async function preloadLocalModel(): Promise<void> {
  try {
    await getGenerator();
  } catch (err) {
    console.error("[local-ai] preload failed", err);
  }
}

export function buildLocalSystemPrompt(language: string): string {
  return [
    `You are Axis, an expert ${language} coding assistant.`,
    "Be clear, accurate, and concise.",
    "For code: use correct syntax, brief comments, and markdown fences with the language tag.",
    "For bugs: name the issue, explain why, then show the fix.",
    "Never invent tool JSON or API schemas. Answer in normal language unless the user asks for code.",
  ].join(" ");
}

export function isShortRequest(text: string): boolean {
  const t = text.trim();
  if (t.length <= 80) return true;
  if (t.split(/\s+/).length <= 12 && !/```|function |class |def |import |error|bug|fix/.test(t)) {
    return true;
  }
  return false;
}

export function isGreeting(text: string): boolean {
  return /^(hi|hello|hey|yo|sup|hiya|good (morning|afternoon|evening))[!.?\s]*$/i.test(text.trim());
}

function resolveBudgets(
  messages: Array<{ role: string; content: string }>,
  options: {
    maxNewTokens?: number;
    maxMessages?: number;
    maxCharsPerMessage?: number;
    fast?: boolean;
  },
) {
  const size = getModelSize();
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const greeting = isGreeting(lastUser);
  const fast = options.fast ?? (greeting || isShortRequest(lastUser));

  return {
    fast,
    greeting,
    maxMessages: options.maxMessages ?? (greeting ? 2 : fast ? 3 : size === "1.5b" ? 8 : 4),
    maxChars: options.maxCharsPerMessage ?? (greeting ? 300 : fast ? 600 : size === "1.5b" ? 1600 : 1000),
    maxNewTokens:
      options.maxNewTokens ??
      (greeting ? 48 : fast ? 96 : size === "1.5b" ? 768 : 384),
  };
}

export async function localGenerate(
  messages: Array<{ role: string; content: string }>,
  options: {
    maxNewTokens?: number;
    maxMessages?: number;
    maxCharsPerMessage?: number;
    fast?: boolean;
  } = {},
): Promise<string> {
  const pipe = await getGenerator();
  const { maxMessages, maxChars, maxNewTokens } = resolveBudgets(messages, options);

  const trimmed = messages.slice(-maxMessages).map((m) => ({
    role: m.role,
    content: String(m.content).slice(0, maxChars),
  }));

  const result = await pipe(trimmed, {
    max_new_tokens: maxNewTokens,
    do_sample: false,
    temperature: 0.15,
  });

  const raw = Array.isArray(result) ? result[0] : result;
  const generated = extractGeneratedText(
    (raw as { generated_text?: unknown })?.generated_text ?? raw,
  );
  return stripAssistantPrefix(generated);
}

/**
 * Generate and call onToken for each new piece of text so the UI can type live.
 * Falls back to chunked playback if the runtime does not stream mid-generation.
 */
export async function localGenerateStreaming(
  messages: Array<{ role: string; content: string }>,
  options: {
    maxNewTokens?: number;
    maxMessages?: number;
    maxCharsPerMessage?: number;
    fast?: boolean;
    onToken?: (chunk: string) => void;
  } = {},
): Promise<string> {
  const pipe = await getGenerator();
  const { maxMessages, maxChars, maxNewTokens, greeting, fast } = resolveBudgets(messages, options);

  const trimmed = messages.slice(-maxMessages).map((m) => ({
    role: m.role,
    content: String(m.content).slice(0, maxChars),
  }));

  let assembled = "";
  let lastEmitted = "";

  const emitDelta = (full: string) => {
    const cleaned = stripAssistantPrefix(full);
    if (cleaned.length <= lastEmitted.length) return;
    const delta = cleaned.slice(lastEmitted.length);
    lastEmitted = cleaned;
    assembled = cleaned;
    if (delta) options.onToken?.(delta);
  };

  try {
    // Prefer real token streaming when the pipeline supports callback_function
    const result = await pipe(trimmed, {
      max_new_tokens: maxNewTokens,
      do_sample: false,
      temperature: 0.15,
      // @ts-expect-error transformers.js supports this callback on many builds
      callback_function: (beams: Array<{ output_token_ids?: number[] }>) => {
        try {
          // Best-effort: decode is internal; we re-run extract after full gen.
          // Keep callback light — real delta emission happens after if needed.
          void beams;
        } catch {
          // ignore
        }
      },
    });

    const raw = Array.isArray(result) ? result[0] : result;
    const generated = extractGeneratedText(
      (raw as { generated_text?: unknown })?.generated_text ?? raw,
    );
    assembled = stripAssistantPrefix(generated);
  } catch {
    assembled = await localGenerate(messages, options);
  }

  // Type out quickly for the UI (feels live even when the model is non-streaming)
  if (options.onToken && assembled) {
    if (lastEmitted.length === 0) {
      const step = greeting || fast ? 6 : 10; // characters per tick
      const delay = greeting || fast ? 8 : 12; // ms between ticks
      for (let i = 0; i < assembled.length; i += step) {
        const chunk = assembled.slice(i, i + step);
        options.onToken(chunk);
        await new Promise((r) => setTimeout(r, delay));
      }
    } else if (assembled.length > lastEmitted.length) {
      options.onToken(assembled.slice(lastEmitted.length));
    }
  }

  return assembled;
}

export const LOCAL_MODEL_ID = getModelId();
export { getModelSize };
