import { pipeline, type TextGenerationPipeline } from "@huggingface/transformers";

let generator: TextGenerationPipeline | null = null;
let loading: Promise<TextGenerationPipeline> | null = null;
let loadedModelId: string | null = null;
let loadFailed = false;

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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s. Try a shorter message.`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function getGenerator(): Promise<TextGenerationPipeline> {
  const modelId = getModelId();

  if (generator && loadedModelId === modelId) return generator;
  if (loadFailed && loadedModelId === modelId) {
    throw new Error("Local model failed to load earlier. Restart the Repl and try again.");
  }

  if (!loading || loadedModelId !== modelId) {
    loading = (async () => {
      console.log(`[local-ai] Loading ${modelId} (first run can take a while)...`);
      const t0 = Date.now();
      try {
        const pipe = await withTimeout(
          pipeline("text-generation", modelId, {
            dtype: "q4",
            device: "cpu",
          }) as Promise<TextGenerationPipeline>,
          180_000,
          "Model load",
        );
        console.log(`[local-ai] Model loaded in ${Date.now() - t0}ms`);
        generator = pipe;
        loadedModelId = modelId;
        loadFailed = false;
        return generator;
      } catch (err) {
        loadFailed = true;
        loadedModelId = modelId;
        loading = null;
        generator = null;
        console.error("[local-ai] load failed", err);
        throw err;
      }
    })();
  }

  return loading;
}

/** Optional warm-up — safe to call; never crashes the process. */
export async function preloadLocalModel(): Promise<void> {
  try {
    await getGenerator();
  } catch (err) {
    console.error("[local-ai] preload failed (non-fatal)", err);
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
    maxMessages: options.maxMessages ?? (greeting ? 2 : fast ? 3 : size === "1.5b" ? 6 : 4),
    maxChars: options.maxCharsPerMessage ?? (greeting ? 300 : fast ? 500 : size === "1.5b" ? 1200 : 800),
    // Keep generation budgets modest on Replit CPU to avoid 502 timeouts
    maxNewTokens:
      options.maxNewTokens ??
      (greeting ? 40 : fast ? 80 : size === "1.5b" ? 512 : 256),
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
  try {
    const pipe = await getGenerator();
    const { maxMessages, maxChars, maxNewTokens } = resolveBudgets(messages, options);

    const trimmed = messages.slice(-maxMessages).map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, maxChars),
    }));

    const result = await withTimeout(
      Promise.resolve(
        pipe(trimmed, {
          max_new_tokens: maxNewTokens,
          do_sample: false,
          temperature: 0.15,
        }),
      ) as Promise<unknown>,
      90_000,
      "Local generation",
    );

    const raw = Array.isArray(result) ? result[0] : result;
    const generated = extractGeneratedText(
      (raw as { generated_text?: unknown })?.generated_text ?? raw,
    );
    return stripAssistantPrefix(generated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[local-ai] generate failed", msg);
    throw new Error(
      msg.includes("timed out")
        ? msg
        : "Local model ran out of memory or crashed. Restart the Repl, keep messages short, and use LOCAL_MODEL_SIZE=0.5b.",
    );
  }
}

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
  const { greeting, fast } = resolveBudgets(messages, options);
  const assembled = await localGenerate(messages, options);

  if (options.onToken && assembled) {
    const step = greeting || fast ? 6 : 10;
    const delay = greeting || fast ? 8 : 12;
    for (let i = 0; i < assembled.length; i += step) {
      options.onToken(assembled.slice(i, i + step));
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return assembled;
}

export const LOCAL_MODEL_ID = getModelId();
export { getModelSize };
