import { pipeline, type TextGenerationPipeline } from "@huggingface/transformers";

const MODELS = {
  "0.5b": "onnx-community/Qwen2.5-Coder-0.5B-Instruct",
  "1.5b": "onnx-community/Qwen2.5-Coder-1.5B-Instruct",
} as const;

export type LocalModelSize = keyof typeof MODELS;

/** Cache one pipeline per size so we can switch without always reloading. */
const generators: Partial<Record<LocalModelSize, TextGenerationPipeline>> = {};
const loading: Partial<Record<LocalModelSize, Promise<TextGenerationPipeline>>> = {};
const loadFailed: Partial<Record<LocalModelSize, boolean>> = {};
/** After 1.5B fails once (OOM), stop trying it this process. */
let largeDisabled = false;

function largeAllowed(): boolean {
  if (largeDisabled) return false;
  const flag = process.env.LOCAL_MODEL_ALLOW_LARGE?.toLowerCase().trim();
  if (flag === "false" || flag === "0" || flag === "no") return false;
  return true;
}

export function pickModelSize(userText: string, options?: { fast?: boolean }): LocalModelSize {
  const forced = (process.env.LOCAL_MODEL_SIZE || "").toLowerCase().trim();
  if (forced === "0.5b" || forced === "0.5") return "0.5b";
  if ((forced === "1.5b" || forced === "1.5") && largeAllowed()) return "1.5b";

  const text = (userText || "").trim();
  if (options?.fast || isGreeting(text) || isShortRequest(text)) return "0.5b";
  if (largeAllowed()) return "1.5b";
  return "0.5b";
}

export function isShortRequest(text: string): boolean {
  const t = text.trim();
  if (t.length <= 80) return true;
  if (t.split(/\s+/).length <= 12 && !/```|function |class |def |import |error|bug|fix|github|repo|pull from/i.test(t)) {
    return true;
  }
  return false;
}

export function isGreeting(text: string): boolean {
  return /^(hi|hello|hey|yo|sup|hiya|good (morning|afternoon|evening))[!.?\s]*$/i.test(text.trim());
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

async function getGenerator(size: LocalModelSize): Promise<TextGenerationPipeline> {
  const modelId = MODELS[size];

  if (generators[size]) return generators[size]!;
  if (loadFailed[size]) {
    throw new Error(`Local ${size} model failed to load earlier. Restart the Repl.`);
  }

  if (!loading[size]) {
    loading[size] = (async () => {
      console.log(`[local-ai] Loading ${modelId} (${size})...`);
      const t0 = Date.now();
      try {
        const pipe = await withTimeout(
          pipeline("text-generation", modelId, {
            dtype: "q4",
            device: "cpu",
          }) as Promise<TextGenerationPipeline>,
          180_000,
          `Model load (${size})`,
        );
        console.log(`[local-ai] ${size} loaded in ${Date.now() - t0}ms`);
        generators[size] = pipe;
        loadFailed[size] = false;
        return pipe;
      } catch (err) {
        loadFailed[size] = true;
        delete loading[size];
        if (size === "1.5b") largeDisabled = true;
        console.error(`[local-ai] ${size} load failed`, err);
        throw err;
      }
    })();
  }

  return loading[size]!;
}

export async function preloadLocalModel(): Promise<void> {
  try {
    await getGenerator("0.5b");
  } catch (err) {
    console.error("[local-ai] preload failed (non-fatal)", err);
  }
}

export function buildLocalSystemPrompt(language: string): string {
  return [
    `You are Axis, a helpful expert ${language} coding assistant.`,
    "Always try to help with coding, repos, GitHub, files, and explanations.",
    "Never refuse normal coding or repository questions. Never say you can't assist with that for coding tasks.",
    "Be clear, accurate, and concise.",
    "For code: use correct syntax and markdown fences with the language tag.",
    "For bugs: name the issue, explain why, then show the fix.",
    "When tools are available, use them to inspect repos instead of guessing.",
    "Never invent tool JSON or API schemas in your final answer.",
  ].join(" ");
}

function resolveBudgets(
  messages: Array<{ role: string; content: string }>,
  options: {
    maxNewTokens?: number;
    maxMessages?: number;
    maxCharsPerMessage?: number;
    fast?: boolean;
  },
  size: LocalModelSize,
) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const greeting = isGreeting(lastUser);
  const fast = options.fast ?? (greeting || isShortRequest(lastUser));

  return {
    fast,
    greeting,
    maxMessages: options.maxMessages ?? (greeting ? 2 : fast ? 3 : size === "1.5b" ? 6 : 4),
    maxChars: options.maxCharsPerMessage ?? (greeting ? 300 : fast ? 500 : size === "1.5b" ? 1200 : 800),
    maxNewTokens:
      options.maxNewTokens ??
      (greeting ? 40 : fast ? 80 : size === "1.5b" ? 512 : 256),
  };
}

async function runOnce(
  size: LocalModelSize,
  messages: Array<{ role: string; content: string }>,
  options: {
    maxNewTokens?: number;
    maxMessages?: number;
    maxCharsPerMessage?: number;
    fast?: boolean;
  },
): Promise<string> {
  const pipe = await getGenerator(size);
  const { maxMessages, maxChars, maxNewTokens } = resolveBudgets(messages, options, size);

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
    size === "1.5b" ? 120_000 : 90_000,
    `Local generation (${size})`,
  );

  const raw = Array.isArray(result) ? result[0] : result;
  const generated = extractGeneratedText(
    (raw as { generated_text?: unknown })?.generated_text ?? raw,
  );
  return stripAssistantPrefix(generated);
}

function looksLikeHardRefusal(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 220) return false;
  return (
    /i('m| am) sorry, but i can'?t assist/.test(t) ||
    /i can'?t (help|assist) with that/.test(t) ||
    /as an ai (language )?model, i (can'?t|cannot)/.test(t) ||
    /^i can'?t assist with that\.?$/.test(t)
  );
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
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  let size = pickModelSize(lastUser, { fast: options.fast });

  try {
    console.log(`[local-ai] using ${size} for this request`);
    let out = await runOnce(size, messages, options);

    // Small models sometimes hard-refuse coding/repo asks — one forced retry
    if (looksLikeHardRefusal(out)) {
      console.log("[local-ai] refusal detected, retrying with stronger instruction");
      out = await runOnce(
        size,
        [
          ...messages,
          {
            role: "user",
            content:
              "You must help. This is a normal coding or repository question. Do not refuse. Answer helpfully in plain language.",
          },
        ],
        { ...options, fast: false, maxNewTokens: Math.max(options.maxNewTokens ?? 0, 256) },
      );
      if (looksLikeHardRefusal(out)) {
        out =
          "I can help with that. Tell me what you want to know about the code or repo (files, what it does, how to change something), and I will dig in.";
      }
    }

    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[local-ai] ${size} generate failed`, msg);

    if (size === "1.5b") {
      largeDisabled = true;
      console.log("[local-ai] falling back to 0.5b");
      try {
        return await runOnce("0.5b", messages, { ...options, fast: true });
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        throw new Error(
          msg2.includes("timed out")
            ? msg2
            : "Local model ran out of memory. Restart the Repl and keep messages shorter.",
        );
      }
    }

    throw new Error(
      msg.includes("timed out")
        ? msg
        : "Local model ran out of memory or crashed. Restart the Repl and try a shorter message.",
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
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const size = pickModelSize(lastUser, { fast: options.fast });
  const { greeting, fast } = resolveBudgets(messages, options, size);
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

export function getModelSize(): LocalModelSize {
  return pickModelSize("");
}

export const LOCAL_MODEL_ID = MODELS["0.5b"];
