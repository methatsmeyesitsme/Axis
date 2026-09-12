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

function compactToolDefinition(tool: LocalToolDefinition): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: "object", properties: {} },
  });
}

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
      ? parsed as Record<string, unknown>
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
      // The caller will receive an empty object and the tool can return a
      // useful validation error instead of crashing the agent loop.
    }
  }
  return {};
}

function inlineArguments(parsed: Record<string, unknown> | null): Record<string, unknown> {
  if (!parsed) return {};
  const explicit = parsed.arguments ?? parsed.args ?? parsed.parameters;
  if (explicit !== undefined) return asArguments(explicit);
  const controlKeys = new Set(["action", "type", "name", "tool", "content", "text"]);
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !controlKeys.has(key)),
  );
}

/**
 * Ask a small local model to either finish the response or call one known
 * tool. JSON is used instead of pretending the model has native function
 * calling. The parser accepts a few common aliases because small models
 * occasionally use "tool"/"args" instead of the requested field names.
 */
export async function localAgentTurn(
  messages: LocalChatMessage[],
  tools: LocalToolDefinition[],
  options: { maxNewTokens?: number } = {},
): Promise<LocalToolDecision> {
  const toolList = tools.map(compactToolDefinition).join("\n");
  const instruction = [
    "Choose the next action for the user request.",
    "Available tools are listed below.",
    toolList || "(No tools are available.)",
    "",
    "Return exactly one JSON object and no markdown.",
    'To call a tool: {"action":"tool","name":"tool_name","arguments":{}}',
    'To answer: {"action":"final","content":"your complete answer"}',
    "Never invent a tool name. Use valid JSON strings and escape newlines.",
  ].join("\n");

  const raw = await localGenerate(
    [...messages, { role: "user", content: instruction }],
    {
      maxNewTokens: options.maxNewTokens ?? 1024,
      maxMessages: 10,
      maxCharsPerMessage: 9000,
    },
  );
  const parsed = extractJsonObject(raw);
  const action = String(parsed?.action ?? parsed?.type ?? "").toLowerCase();
  const toolName = String(parsed?.name ?? parsed?.tool ?? "").trim();

  const aliasedToolName = tools.some((tool) => tool.name === action) ? action : toolName;
  if (
    (action === "tool" || toolName || aliasedToolName) &&
    tools.some((tool) => tool.name === aliasedToolName)
  ) {
    return {
      kind: "tool",
      name: aliasedToolName,
      arguments: inlineArguments(parsed),
    };
  }

  if (action === "final" && typeof parsed?.content === "string") {
    const nested = extractJsonObject(parsed.content);
    const nestedAction = String(nested?.action ?? nested?.type ?? "").toLowerCase();
    const nestedName = String(nested?.name ?? nested?.tool ?? "").trim();
    const nestedAliasedName = tools.some((tool) => tool.name === nestedAction) ? nestedAction : nestedName;
    if (
      (nestedAction === "tool" || nestedName || nestedAliasedName) &&
      tools.some((tool) => tool.name === nestedAliasedName)
    ) {
      return {
        kind: "tool",
        name: nestedAliasedName,
        arguments: inlineArguments(nested),
      };
    }
    return { kind: "final", content: parsed.content.trim() };
  }

  // A malformed tool envelope is safer as a user-visible answer than an
  // unbounded retry loop. The local model can still be useful for plain chat.
  return { kind: "final", content: raw.trim() };
}

export function buildLocalToolResultMessage(
  name: string,
  result: { output?: unknown; error?: string },
): string {
  return [
    `Tool result for ${name}:`,
    JSON.stringify(result.error ? { error: result.error } : { output: result.output ?? "ok" }),
    "Continue the task. Call another tool if needed, otherwise return the final answer.",
  ].join("\n");
}