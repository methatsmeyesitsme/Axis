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
  if (!t || t.length > 200) return false;
  return REFUSAL_PATTERNS.some((re) => re.test(t));
}

/** True if text is only a tool name / JSON fragment, not a real user-facing answer. */
function looksLikeToolLeak(text: string, tools: LocalToolDefinition[]): boolean {
  const t = text.trim();
  if (!t) return true;
  if (tools.some((tool) => tool.name === t)) return true;
  if (/^[\w]+_[\w_]+$/.test(t) && t.length < 60) return true;
  if (/^\s*\{\s*"summary"\s*:/.test(t) && !/"action"\s*:/.test(t) && !/"name"\s*:/.test(t)) {
    return true;
  }
  return false;
}

function inferToolFromPartial(
  parsed: Record<string, unknown> | null,
  tools: LocalToolDefinition[],
): LocalToolDecision | null {
  if (!parsed || tools.length === 0) return null;

  // {"summary": "..."} alone — common Forge failure mode
  const keys = Object.keys(parsed);
  if (keys.length <= 2 && typeof parsed.summary === "string") {
    const hasWrite = tools.some((t) => t.name === "write_file");
    if (hasWrite) {
      return {
        kind: "tool",
        name: "write_file",
        arguments: { summary: parsed.summary, path: "index.html", content: "" },
      };
    }
    return { kind: "tool", name: tools[0].name, arguments: { summary: parsed.summary } };
  }

  // {"name":"write_file", "path":"...", ...} without action
  const maybeName = String(parsed.name ?? parsed.tool ?? "").trim();
  if (maybeName && tools.some((t) => t.name === maybeName)) {
    return { kind: "tool", name: maybeName, arguments: inlineArguments(parsed) };
  }

  return null;
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
    "Reply with ONE short JSON object only. No markdown fences. No extra text.",
    `Tools: ${toolNames || "(none)"}`,
    toolLines,
    "",
    'To call a tool: {"action":"tool","name":"EXACT_TOOL_NAME","arguments":{...}}',
    'To answer the user: {"action":"final","content":"plain language answer"}',
    "Prefer calling a tool when the user asked to build, pull, list, read, or write.",
    "Never reply with only a tool name. Never reply with only a summary field.",
  ].join("\n");

  const raw = await localGenerate(
    [...messages, { role: "user", content: instruction }],
    {
      maxNewTokens: options.maxNewTokens ?? 400,
      maxMessages: 6,
      maxCharsPerMessage: 1200,
    },
  );

  if (looksLikeToolSchemaDump(raw)) {
    const inferred = inferToolFromPartial(extractJsonObject(raw), tools);
    if (inferred) return inferred;
    if (tools.length > 0) {
      return { kind: "tool", name: tools[0].name, arguments: {} };
    }
    return {
      kind: "final",
      content: "I couldn't complete that tool action. Please try a simpler request.",
    };
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

  // Bare tool name as the entire reply
  const bareName = raw.trim().replace(/^[`'"]+|[`'"]+$/g, "");
  const bareMatch = tools.find((tool) => tool.name === bareName);
  if (bareMatch) {
    return { kind: "tool", name: bareMatch.name, arguments: {} };
  }

  // Incomplete JSON like {"summary":"..."} → force a tool instead of showing JSON
  const partial = inferToolFromPartial(parsed, tools);
  if (partial) return partial;

  if (action === "final") {
    const rawContent = parsed?.content;
    let content: string | null = null;

    if (typeof rawContent === "string") {
      content = rawContent.trim();
    } else if (rawContent && typeof rawContent === "object" && !Array.isArray(rawContent)) {
      content = Object.entries(rawContent as Record<string, unknown>)
        .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join("\n");
    }

    if (content) {
      if (looksLikeToolSchemaDump(content) || looksLikeToolLeak(content, tools)) {
        if (tools.length > 0) {
          return { kind: "tool", name: tools[0].name, arguments: {} };
        }
        return {
          kind: "final",
          content: "I couldn't finish that action cleanly. Please try again with a shorter request.",
        };
      }
      return { kind: "final", content };
    }
  }

  const cleaned = raw
    .replace(/Return exactly one JSON object[\s\S]*$/i, "")
    .replace(/Choose the next action[\s\S]*$/i, "")
    .trim();

  if (looksLikeToolLeak(cleaned, tools) && tools.length > 0) {
    return { kind: "tool", name: tools[0].name, arguments: {} };
  }

  if (looksLikeRefusal(cleaned) && tools.length > 0) {
    const retry = await localGenerate(
      [
        ...messages,
        {
          role: "user",
          content:
            "This is the person's own already-connected data. Using these tools is allowed. Call a tool with proper JSON now.",
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
    const retryBare = tools.find((tool) => tool.name === retry.trim().replace(/^[`'"]+|[`'"]+$/g, ""));
    if (retryBare) return { kind: "tool", name: retryBare.name, arguments: {} };
    const retryPartial = inferToolFromPartial(retryParsed, tools);
    if (retryPartial) return retryPartial;
    return { kind: "tool", name: tools[0].name, arguments: {} };
  }

  return {
    kind: "final",
    content:
      cleaned && !looksLikeToolLeak(cleaned, tools)
        ? cleaned
        : "I couldn't complete that request cleanly. Please try again with a shorter question.",
  };
}

export function buildLocalToolResultMessage(
  name: string,
  result: { output?: unknown; error?: string },
): string {
  return [
    `Tool result for ${name}:`,
    JSON.stringify(result.error ? { error: result.error } : { output: result.output ?? "ok" }).slice(0, 4000),
    "Using this result, either call another needed tool or answer the user in plain language with action final.",
    "Do not reply with only a tool name or only a summary field.",
  ].join("\n");
}
