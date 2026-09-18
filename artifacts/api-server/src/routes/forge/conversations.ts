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

const HISTORY_LIMIT = 40;
const HISTORY_MSG_CHARS = 4000;
const CURRENT_MSG_CHARS = 8000;
const MAX_TOOL_TURNS = 8;

/**
 * Only true for clear pull/import intent — not describe, not "make a site".
 * This is action routing to the correct tool, not a canned chat template.
 */
function isExplicitPullIntent(userText: string): boolean {
  const t = userText.trim().toLowerCase();
  if (!t || t.length > 120) return false;
  // "pull" / "pull again" / "clone" / "import" alone
  if (/^(please\s+)?(pull|clone|import)(\s+(again|it|now))?\.?$/i.test(t)) return true;
  // "pull from my connected repo", "load my repo", etc.
  if (
    /^(please\s+)?(pull|clone|import|fetch|load)\s+(from\s+)?(my\s+)?(connected\s+)?(repo|repository|github)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/^pull from (my )?(connected )?(repo|github)/i.test(t)) return true;
  return false;
}

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
- Answer in natural language. No canned template replies.
- If they want to chat, explain, or describe something — reply in text. Do not call tools unless needed.
- If they want to build or change an app — use write_file / run_preview (always include non-empty content for write_file).
- If they want to pull their connected GitHub repo, call import_github_repo then run_preview. Never invent a new website when they asked to pull.
- Never call write_file with empty content.
- Prefer one complete index.html with inline CSS/JS for simple apps. Mobile-friendly.
- Every tool call needs a short summary argument.
- After writing files, call run_preview so they can press Run.
${filesBlock}${historyBlock}
${opts.isPersisted ? "" : "\nUser is not logged in — ask them to log in in Settings before building or pulling."}`;
}

function summarizeHistoryForPrompt(history: Array<{ role: string; content: string }>): string {
  const prior = history.slice(0, -1);
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

function formatPullResult(output: unknown, error?: string): string {
  if (error) return `Could not pull the connected repo: ${error}`;
  const o = (output ?? {}) as {
    imported?: number;
    promotedFrom?: string;
    builtFromMonorepo?: { package?: string; files?: number; buildMs?: number } | null;
    buildError?: string | null;
    hasIndexHtml?: boolean;
    files?: string[];
  };
  if (o.builtFromMonorepo?.package) {
    const b = o.builtFromMonorepo;
    return `Pulled and built **${b.package}** (${b.files ?? "?"} files${b.buildMs != null ? `, ${b.buildMs}ms` : ""}). Press **Run** to preview.`;
  }
  if (o.buildError) {
    return `Pulled **${o.imported ?? 0}** file(s), but the monorepo build failed: ${String(o.buildError).slice(0, 400)}. You can try building a specific package next.`;
  }
  if (o.hasIndexHtml) {
    return o.promotedFrom
      ? `Pulled **${o.imported ?? 0}** file(s). Promoted **${o.promotedFrom}** → **index.html**. Press **Run** to preview.`
      : `Pulled **${o.imported ?? 0}** file(s) from your connected repo. Press **Run** to preview.`;
  }
  const names = (o.files ?? []).slice(0, 12).join(", ") || "none listed";
  return `Pulled files (${names}) but there is no root index.html yet.`;
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

  const historyForModel = isPersisted
    ? [...history, { role: "user", content }]
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
    // Clear pull intent → import_github_repo only (model was inventing write_file websites)
    if (isExplicitPullIntent(content)) {
      if (!isPersisted) {
        const msg =
          "Log in and connect GitHub in **Settings** (PAT with repo scope), then say **pull** again.";
        savedContent = msg;
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
      } else {
        const importResult = await runTool("import_github_repo", {
          path: "",
          summary: "Pulled connected repo",
        });
        if (!importResult.error) {
          const out = importResult.output as { hasIndexHtml?: boolean } | undefined;
          if (out?.hasIndexHtml) {
            await runTool("run_preview", { summary: "Preview ready" });
          }
        }
        const msg = formatPullResult(importResult.output, importResult.error);
        savedContent += (savedContent ? "\n\n" : "") + msg;
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
      }
    } else if (getAiProvider() === "local") {
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
        // Guard: never allow empty write_file content
        if (decision.name === "write_file" && !String(args.content ?? "").trim()) {
          workingMessages.push({
            role: "assistant",
            content: JSON.stringify({ action: "tool", name: decision.name, arguments: args }),
          });
          workingMessages.push({
            role: "user",
            content:
              "Tool error: write_file requires non-empty content. If the user asked to pull a repo, call import_github_repo instead of write_file.",
          });
          continue;
        }

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
        const fallback = "What would you like to do next?";
        savedContent = fallback;
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ content: fallback })}\n\n`);
        }
      }
    } else {
      const msg =
        "Forge is set to the local AI path for building apps. Switch AI provider to local or try again.";
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
