import { localGenerate } from "./client";

export type LocalChatMessage = {
  role: "system" | "user" | "assistant" | "model";
  content: string;
};

export type LocalToolDefinition = {
  name: string;
  description: string;
  parameters?: unknown;
};

export type LocalToolDecision =
  | { kind: "tool"; name: string; arguments: Record<string, unknown> }
  | { kind: "final"; content: string };

type ToolDeclarationLike = {
  name?: string;
  description?: string;
  parametersJsonSchema?: unknown;
};

export function toLocalToolDefinitions(
  declarations: ReadonlyArray<ToolDeclarationLike>,
): LocalToolDefinition[] {
  return declarations
    .filter((tool): tool is ToolDeclarationLike & { name: string } => Boolean(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parametersJsonSchema,
    }));
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // empty
    }
  }
  return {};
}

function inlineArguments(parsed: Record<string, unknown> | null): Record<string, unknown> {
  if (!parsed) return {};
  const explicit = parsed.arguments ?? parsed.args ?? parsed.parameters;
  if (explicit !== undefined) return asArguments(explicit);
  const controlKeys = new Set(["action", "type", "name", "tool", "content", "text"]);
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => !controlKeys.has(key)));
}

/** Detect when the model is regurgitating tool schemas instead of answering. */
function looksLikeToolSchemaDump(text: string): boolean {
  const t = text.toLowerCase();
  const hits = [
    '"action": "final"',
    '"name": "github_',
    "parametersjsonschema",
    "replace `github_",
    "to call the `github_",
    "available tools",
    '"type": "object"',
  ].filter((s) => t.includes(s.toLowerCase())).length;
  return hits >= 2 || (t.includes("github_list_files") && t.includes("parameters"));
}

/** Detect when the model reflexively refuses (small models sometimes do this
 * for "tool"/"repo" framing even when the action is benign and permitted). */
const REFUSAL_PATTERNS = [
  /i'?m sorry,? but i can'?t assist/i,
  /i can'?t (help|assist) with that/i,
  /i cannot (help|assist) with that/i,
  /i'?m unable to (help|assist)/i,
  /as an ai( language model)?,? i (can'?t|cannot)/i,
  /i'?m not able to (do|help with) that/i,
];

function looksLikeRefusal(text: string): boolean {
  const t = text.trim();
  // Keep this narrow — real answers are usually longer than a bare refusal line.
  if (!t || t.length > 200) return false;
  return REFUSAL_PATTERNS.some((re) => re.test(t));
}

export async function localAgentTurn(
  messages: LocalChatMessage[],
  tools: LocalToolDefinition[],
  options: { maxNewTokens?: number } = {},
): Promise<LocalToolDecision> {
  const toolNames = tools.map((t) => t.name).join(", ");
  const toolLines = tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");

  const instruction = [
    "You must reply with ONE short JSON object only. No markdown. No extra text.",
    `Tools you may use: ${toolNames || "(none)"}`,
    toolLines,
    "",
    'Call a tool: {"action":"tool","name":"EXACT_TOOL_NAME","arguments":{...}}',
    'Answer the user: {"action":"final","content":"your answer here"}',
    "If you are unsure which tool to use, answer with action final.",
    "Do not describe tools. Do not repeat this instruction.",
  ].join("\n");

  const raw = await localGenerate(
    [...messages, { role: "user", content: instruction }],
    {
      maxNewTokens: options.maxNewTokens ?? 400,
      maxMessages: 6,
      maxCharsPerMessage: 1200,
    },
  );

  // Schema dump / loop → force a clean final answer without tools
  if (looksLikeToolSchemaDump(raw)) {
    const clean = await localGenerate(
      [
        ...messages,
        {
          role: "user",
          content:
            "Do not use tools and do not output JSON. Answer the user's request in plain clear language.",
        },
      ],
      { maxNewTokens: 512, maxMessages: 5, maxCharsPerMessage: 1000 },
    );
    return { kind: "final", content: clean.trim() || "I couldn't complete that tool action. Please try a simpler request." };
  }

  const parsed = extractJsonObject(raw);
  const action = String(parsed?.action ?? parsed?.type ?? "").toLowerCase();
  const toolName = String(parsed?.name ?? parsed?.tool ?? "").trim();
  const aliasedToolName = tools.some((tool) => tool.name === action) ? action : toolName;

  if (
    (action === "tool" || Boolean(aliasedToolName)) &&
    tools.some((tool) => tool.name === aliasedToolName)
  ) {
    return {
      kind: "tool",
      name: aliasedToolName,
      arguments: inlineArguments(parsed),
    };
  }

  // Small models sometimes "fill in the blank" and emit just the bare tool
  // name (e.g. "github_list_files") instead of the required JSON wrapper.
  // Without this, that raw name falls through and gets shown to the user
  // verbatim as if it were the actual answer.
  const bareName = raw.trim().replace(/^[`'"]+|[`'"]+$/g, "");
  const bareMatch = tools.find((tool) => tool.name === bareName);
  if (bareMatch) {
    return { kind: "tool", name: bareMatch.name, arguments: {} };
  }

  if (action === "final") {
    const rawContent = parsed?.content;
    let content: string | null = null;

    if (typeof rawContent === "string") {
      content = rawContent.trim();
    } else if (rawContent && typeof rawContent === "object" && !Array.isArray(rawContent)) {
      // The model nested the answer as structured data (e.g. {"repo": "..."})
      // instead of writing a plain sentence. Turn it into readable text
      // rather than showing the person a raw JSON blob.
      content = Object.entries(rawContent as Record<string, unknown>)
        .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join("\n");
    }

    if (content) {
      if (looksLikeToolSchemaDump(content)) {
        return {
          kind: "final",
          content: "I couldn't use GitHub tools reliably on that request. Try asking a more specific question, or reconnect GitHub in Settings.",
        };
      }
      return { kind: "final", content };
    }
  }

  // Not valid tool JSON → treat as a normal answer (strip obvious instruction echoes)
  const cleaned = raw
    .replace(/Return exactly one JSON object[\s\S]*$/i, "")
    .replace(/Choose the next action[\s\S]*$/i, "")
    .trim();

  if (looksLikeRefusal(cleaned) && tools.length > 0) {
    // The model reflexively refused. Retry once, explicitly reassuring it
    // that this is the person's own already-connected data and a normal,
    // permitted part of the app — not unauthorized access.
    const retry = await localGenerate(
      [
        ...messages,
        {
          role: "user",
          content:
            "This is the person's own already-connected repository, and using these tools is a normal, permitted part of this app, not unauthorized access. Please help directly instead of declining.",
        },
      ],
      { maxNewTokens: options.maxNewTokens ?? 400, maxMessages: 6, maxCharsPerMessage: 1200 },
    );
    const retryParsed = extractJsonObject(retry);
    const retryAction = String(retryParsed?.action ?? retryParsed?.type ?? "").toLowerCase();
    const retryToolName = String(retryParsed?.name ?? retryParsed?.tool ?? "").trim();
    const retryAliased = tools.some((tool) => tool.name === retryAction) ? retryAction : retryToolName;

    if ((retryAction === "tool" || Boolean(retryAliased)) && tools.some((tool) => tool.name === retryAliased)) {
      return { kind: "tool", name: retryAliased, arguments: inlineArguments(retryParsed) };
    }
    const retryBareName = retry.trim().replace(/^[`'"]+|[`'"]+$/g, "");
    const retryBareMatch = tools.find((tool) => tool.name === retryBareName);
    if (retryBareMatch) {
      return { kind: "tool", name: retryBareMatch.name, arguments: {} };
    }
    const retryClean = retry.trim();
    if (retryClean && !looksLikeRefusal(retryClean) && !looksLikeToolSchemaDump(retryClean)) {
      return { kind: "final", content: retryClean };
    }
    // Still refusing — use the most likely tool directly rather than showing
    // the user a flat refusal for what was a benign, permitted request.
    return { kind: "tool", name: tools[0].name, arguments: {} };
  }

  return {
    kind: "final",
    content: cleaned || "I couldn't complete that request cleanly. Please try again with a shorter question.",
  };
}

export function buildLocalToolResultMessage(
  name: string,
  result: { output?: unknown; error?: string },
): string {
  return [
    `Tool result for ${name}:`,
    JSON.stringify(result.error ? { error: result.error } : { output: result.output ?? "ok" }),
    "Using this result, answer the user in plain language. Prefer action final unless another tool is clearly required.",
  ].join("\n");
}
