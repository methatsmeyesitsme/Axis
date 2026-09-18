import { Router, type IRouter } from "express";
import { db, conversations, messages, forgeAppFiles } from "@workspace/db";
import {
  localAgentTurn,
  buildLocalToolResultMessage,
  toLocalToolDefinitions,
  type LocalChatMessage,
} from "@workspace/integrations-local-ai";
import { eq, desc, isNull } from "drizzle-orm";
import { forgeToolDeclarations, executeForgeTool, truncateSummary } from "./forge-tools";
import { friendlyGeminiErrorMessage } from "../../lib/gemini-errors";
import { getAiProvider } from "../../lib/ai-provider";

const router: IRouter = Router();

/** How many past messages to feed the model (strong memory). */
const HISTORY_LIMIT = 40;
/** Max characters per history message (keep early context, trim long tool dumps). */
const HISTORY_MSG_CHARS = 4000;
const CURRENT_MSG_CHARS = 8000;
const MAX_TOOL_TURNS = 8;

function deriveAppTitle(userText: string): string {
  const t = userText.trim().replace(/\s+/g, " ");
  if (!t) return "New App";
  const quoted = userText.match(/["\u201c']([^"\u201d']{1,40})["\u201d']/);
  if (quoted?.[1]?.trim()) {
    const q = quoted[1].trim();
    return q.charAt(0).toUpperCase() + q.slice(1);
  }
  let title = t
    .replace(/^(please\s+)?(make|build|create|write)\s+(me\s+)?(an?\s+)?(app|page|website|site)\s+(that\s+)?/i, "")
    .trim();
  if (!title) title = t;
  if (title.length > 36) title = title.slice(0, 33) + "…";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

async function autoTitleIfDefault(appId: number, userText: string): Promise<void> {
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, appId));
  if (!conv || conv.source !== "forge") return;
  if (conv.title !== "New App" && conv.title !== "New Chat") return;
  const title = deriveAppTitle(userText);
  if (!title || title === "New App") return;
  await db.update(conversations).set({ title }).where(eq(conversations.id, appId));
}

function isToolProtocolLeak(text: string): boolean {
  return /["']?(write_file|delete_file|import_github_repo|run_preview|db_get|db_set|db_delete|db_list|create_table|table_list|table_insert|table_select|table_update|table_delete|write_backend_handler|add_accounts|build_workspace_app)["']?\s*:/i.test(
    text,
  )
    || (/["']?file["']?\s*:/.test(text) && /["']?preview["']?\s*:/.test(text) && /["']?summary["']?\s*:/.test(text))
    || (/["']?(action|tool|arguments)["']?\s*:/.test(text) && /["']?(name|tool)["']?\s*:/.test(text));
}

async function listAppFilePaths(appId: number): Promise<string[]> {
  try {
    const rows = await db
      .select({ path: forgeAppFiles.path })
      .from(forgeAppFiles)
      .where(eq(forgeAppFiles.appId, appId));
    return rows.map((r) => r.path).slice(0, 60);
  } catch {
    return [];
  }
}

function buildSystemPrompt(opts: {
  nowUtc: string;
  timeUtc: string;
  isPersisted: boolean;
  appFiles: string[];
  historySummary: string;
}): string {
  const filesBlock =
    opts.appFiles.length > 0
      ? `\n\nFILES CURRENTLY IN THIS APP (remember these across the chat):\n${opts.appFiles.map((p) => `- ${p}`).join("\n")}`
      : "\n\nFILES CURRENTLY IN THIS APP: (none yet)";

  const historyBlock = opts.historySummary
    ? `\n\nRECENT CONVERSATION THREAD (use this — do not forget earlier requests):\n${opts.historySummary}`
    : "";

  return `Today is ${opts.nowUtc}, ${opts.timeUtc} UTC.

You are Forge, a coding assistant that builds and previews web apps for the user inside this product (Axis).

MEMORY (critical):
- You have the full recent chat history in the messages below. Treat it as ground truth.
- Remember what the user asked earlier, what you already built or pulled, and what files exist.
- Do not pretend the conversation just started. Refer back to prior steps when relevant.
- If they say "again", "that", "the repo", or "fix it", use prior context — do not ask them to repeat everything.

HOW TO RESPOND:
- Answer in natural language. There are NO magic phrases. Understand intent from the whole message and history.
- If they want to chat, explain, or describe something — reply in text. Do not call tools unless needed.
- If they want to build or change an app — use tools (write_file, run_preview, etc.).
- If they want to load their connected GitHub repo — use import_github_repo, then run_preview when ready.
- If they want a monorepo package built for preview — use build_workspace_app (e.g. package "axis-preview").
- Prefer one complete index.html with inline CSS/JS for simple apps. Mobile-friendly (viewport, full width).
- Do not invent a generic "hi" placeholder page. Build what they asked for.
- Every tool call needs a short summary argument.
- After writing files, call run_preview so they can press Run.
${filesBlock}${historyBlock}
${opts.isPersisted ? "" : "\nUser is not logged in — ask them to log in in Settings before building or pulling."}`;
}

function summarizeHistoryForPrompt(history: Array<{ role: string; content: string }>): string {
  // Compact digest of older messages so the model keeps long-thread awareness
  const prior = history.slice(0, -1); // exclude message just saved as current user turn if duplicated
  if (prior.length === 0) return "";
  return prior
    .slice(-20)
    .map((m) => {
      const role = m.role === "assistant" ? "Forge" : "User";
      const body = m.content.replace(/\s+/g, " ").trim().slice(0, 280);
      return `${role}: ${body}`;
    })
    .join("\n");
}

router.get("/", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const result = await db
    .select()
    .from(conversations)
    .where(userId ? eq(conversations.userId, userId) : isNull(conversations.userId))
    .orderBy(desc(conversations.createdAt));
  res.json(
    result
      .filter((c) => c.source === "forge")
      .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt })),
  );
});

router.post("/", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const { title = "New App" } = req.body as { title?: string };
  if (!userId) {
    res.status(201).json({ id: -1, title, createdAt: new Date().toISOString() });
    return;
  }
  const existing = await db.select().from(conversations).where(eq(conversations.userId, userId));
  if (existing.filter((c) => c.source === "forge").length >= 10) {
    res.status(400).json({ error: "You've reached the 10-app limit. Delete an app to make room for a new one." });
    return;
  }
  const [created] = await db
    .insert(conversations)
    .values({ title, language: "General", source: "forge", userId })
    .returning();
  res.status(201).json({ id: created.id, title: created.title, createdAt: created.createdAt });
});

router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "forge") {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);
  res.json({
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    messages: msgs.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
  });
});

router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { title } = req.body as { title: string };
  if (!title?.trim()) {
    res.status(400).json({ error: "Title required" });
    return;
  }
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "forge") {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const [updated] = await db
    .update(conversations)
    .set({ title: title.trim() })
    .where(eq(conversations.id, id))
    .returning();
  res.json({ id: updated.id, title: updated.title, createdAt: updated.createdAt });
});

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "forge") {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  await db.delete(conversations).where(eq(conversations.id, id));
  res.status(204).end();
});

router.get("/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);
  res.json(
    msgs.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
  );
});

router.post("/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const { content, guestHistory: rawGuestHistory } = req.body as {
    content: string;
    guestHistory?: Array<{ role: string; content: string }>;
  };
  const guestHistory: Array<{ role: string; content: string }> = rawGuestHistory ?? [];
  const userId = req.session?.userId ?? null;
  const isPersisted = !!userId && id > 0;

  if (isPersisted) {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv || conv.source !== "forge") {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
  }

  const history: Array<{ role: string; content: string }> = isPersisted
    ? (
        await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, id))
          .orderBy(messages.createdAt)
      ).map((m) => ({ role: m.role, content: m.content }))
    : guestHistory;

  if (isPersisted) {
    await db.insert(messages).values({ conversationId: id, role: "user", content });
    await autoTitleIfDefault(id, content);
  }

  // History for the model: include the new user message + prior turns
  const historyForModel = isPersisted
    ? [
        ...history,
        { role: "user", content },
      ]
    : [...guestHistory, { role: "user", content }];

  const appFiles = isPersisted ? await listAppFilePaths(id) : [];
  const nowUtc = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const timeUtc = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: true,
  });

  const systemPrompt = buildSystemPrompt({
    nowUtc,
    timeUtc,
    isPersisted,
    appFiles,
    historySummary: summarizeHistoryForPrompt(historyForModel),
  });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ status: "working" })}\n\n`);

  let savedContent = "";

  const runTool = async (name: string, args: Record<string, unknown>) => {
    const toolId = `${Date.now()}-${name}`;
    const summary =
      name === "write_file" && String(args.path ?? "").trim()
        ? `Writing ${String(args.path).replace(/^\/+/, "")}`
        : name === "import_github_repo"
          ? "Pulling connected repo"
          : name === "build_workspace_app"
            ? `Building ${String(args.package ?? "workspace app")}`
            : truncateSummary(args.summary, name);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name, summary } })}\n\n`);
    }
    const result = isPersisted
      ? await executeForgeTool(id, name, args, userId)
      : { error: "Log in first so the app can be saved." };
    if (result.error) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ toolError: { id: toolId, summary, error: result.error } })}\n\n`);
      }
      savedContent += `\n\n✗ ${summary} — ${result.error}`;
    } else {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ toolDone: { id: toolId, summary } })}\n\n`);
      }
      savedContent += `\n\n✓ ${summary}`;
    }
    return result;
  };

  try {
    if (getAiProvider() === "local") {
      const localTools = toLocalToolDefinitions(
        forgeToolDeclarations as unknown as Array<{
          name: string;
          description?: string;
          parametersJsonSchema?: unknown;
        }>,
      );

      const workingMessages: LocalChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...historyForModel.slice(-HISTORY_LIMIT).map(
          (m): LocalChatMessage => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content.slice(0, HISTORY_MSG_CHARS),
          }),
        ),
      ];
      // Ensure latest user text is not over-truncated in the last slot
      if (workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") {
          last.content = content.slice(0, CURRENT_MSG_CHARS);
        }
      }

      let finalText = "";
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const decision = await localAgentTurn(workingMessages, localTools, {
          maxNewTokens: 1600,
        });

        if (decision.kind === "final") {
          finalText = decision.content || "";
          break;
        }

        const args = (decision.arguments ?? {}) as Record<string, unknown>;
        const result = await runTool(decision.name, args);

        workingMessages.push({
          role: "assistant",
          content: JSON.stringify({
            action: "tool",
            name: decision.name,
            arguments: args,
          }),
        });
        workingMessages.push({
          role: "user",
          content: buildLocalToolResultMessage(decision.name, result),
        });

        // Refresh file list in context after mutating tools
        if (
          decision.name === "write_file" ||
          decision.name === "import_github_repo" ||
          decision.name === "build_workspace_app" ||
          decision.name === "delete_file"
        ) {
          const files = isPersisted ? await listAppFilePaths(id) : [];
          workingMessages[0] = {
            role: "system",
            content: buildSystemPrompt({
              nowUtc,
              timeUtc,
              isPersisted,
              appFiles: files,
              historySummary: summarizeHistoryForPrompt(historyForModel),
            }),
          };
        }
      }

      if (finalText && !isToolProtocolLeak(finalText)) {
        savedContent += (savedContent ? "\n\n" : "") + finalText;
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ content: finalText })}\n\n`);
        }
      } else if (!savedContent.trim()) {
        const fallback =
          "I'm here — tell me what you want to build, change, or load from your connected repo. I'll use the full chat history, so you don't need special phrases.";
        savedContent = fallback;
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ content: fallback })}\n\n`);
        }
      }
    } else {
      // Non-local: still model-style — no phrase routers. Prefer tools via local path when available.
      // Fall back to a clear instruction if Gemini path isn't fully wired for Forge tools here.
      const msg =
        "Forge is set to the local AI path for building apps. If this message appears, switch AI provider to local or try again.";
      savedContent = msg;
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[forge] messages error", err);
    const friendly = friendlyGeminiErrorMessage(err, `Something went wrong: ${detail}`);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: friendly })}\n\n`);
    }
  }

  if (isPersisted && savedContent.trim()) {
    await db.insert(messages).values({
      conversationId: id,
      role: "assistant",
      content: savedContent.trim(),
    });
  }
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  }
});

export default router;
