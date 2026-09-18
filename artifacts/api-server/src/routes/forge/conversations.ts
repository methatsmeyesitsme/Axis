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
import { describeMonorepo } from "./forge-workspace-build";
import { friendlyGeminiErrorMessage } from "../../lib/gemini-errors";
import { getAiProvider } from "../../lib/ai-provider";

const router: IRouter = Router();

const HISTORY_LIMIT = 40;
const HISTORY_MSG_CHARS = 4000;
const CURRENT_MSG_CHARS = 8000;
const MAX_TOOL_TURNS = 8;

function isExplicitPullIntent(userText: string): boolean {
  const t = (userText || "").trim().toLowerCase();
  if (!t) return false;
  if (t === "pull" || t === "pull again" || t === "pull it" || t === "pull now") return true;
  if (t.startsWith("pull ") || t.startsWith("please pull")) return true;
  if (t.startsWith("clone ") || t.startsWith("import ")) return true;
  if (t.includes("pull") && (t.includes("repo") || t.includes("github") || t.includes("connected"))) return true;
  return false;
}

function wantsDescribeWithPull(userText: string): boolean {
  const t = (userText || "").toLowerCase();
  return t.includes("describe") || t.includes("explain") || t.includes("what is") || t.includes("tell me about");
}

function isGreeting(userText: string): boolean {
  const t = (userText || "").trim().toLowerCase();
  return /^(hi|hello|hey|yo|sup|good\s+(morning|afternoon|evening))[\s!.?]*$/i.test(t);
}

function isDescribeRepoIntent(userText: string): boolean {
  const t = (userText || "").trim().toLowerCase();
  if (!t) return false;
  if (isExplicitPullIntent(t)) return false;
  return (
    (t.includes("describe") && (t.includes("repo") || t.includes("project") || t.includes("axis"))) ||
    t.includes("what is my repo") ||
    t.includes("tell me about my repo") ||
    t === "describe my repo" ||
    t === "describe the repo"
  );
}

function formatRepoDescription(): string {
  try {
    const { root, packages } = describeMonorepo();
    if (!root) {
      return "Axis is this product's monorepo (preview package: artifacts/axis-preview).";
    }
    const names = packages.map((p) => p.relativeDir).slice(0, 12);
    const list = names.length ? names.map((n) => "• " + n).join("\n") : "(packages listed after git pull)";
    return (
      "**Axis** monorepo" +
      (root ? ` at \`${root}\`` : "") +
      ".\n\n" +
      "Frontend packages:\n" +
      list +
      "\n\n" +
      "Preview uses **artifacts/axis-preview**. Press **Run** after a pull."
    );
  } catch {
    return "Axis is a monorepo; Forge preview targets artifacts/axis-preview.";
  }
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
      ? `\n\nFILES CURRENTLY IN THIS APP:\n${opts.appFiles.map((p) => `- ${p}`).join("\n")}`
      : "\n\nFILES CURRENTLY IN THIS APP: (none yet)";

  const historyBlock = opts.historySummary
    ? `\n\nRECENT CONVERSATION THREAD:\n${opts.historySummary}`
    : "";

  return `Today is ${opts.nowUtc}, ${opts.timeUtc} UTC.

You are Forge, a coding assistant that builds and previews web apps.

MEMORY: Use the chat history. Do not pretend the conversation just started.

HOW TO RESPOND:
- Natural language. No canned templates.
- Chat / explain / describe → text only, no tools unless needed.
- Only call import_github_repo when the user explicitly says pull/clone/import the repo. Never for describe, hi, or general chat.
- Build apps with write_file (non-empty content) then run_preview.
- Prefer one complete index.html with inline CSS/JS for simple apps.
- Every tool needs a short summary argument.
${filesBlock}${historyBlock}
${opts.isPersisted ? "" : "\nUser is not logged in — ask them to log in in Settings before building."}`;
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
  if (error) return `Could not load the repo: ${error}`;
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
    return `Loaded **${b.package}** (${b.files ?? "?"} files${b.buildMs != null ? `, ${b.buildMs}ms` : ""}). Press **Run** to preview.`;
  }
  if (o.buildError) {
    return `Problem loading preview: ${String(o.buildError).slice(0, 400)}`;
  }
  if (o.hasIndexHtml) {
    return "Preview is ready. Press **Run**.";
  }
  return "Loaded files but no index yet.";
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
    // Pull first — never fall through to AI for pull requests
    if (isExplicitPullIntent(content)) {
      if (!isPersisted) {
        const msg = "Log in in **Settings**, then say **pull** again.";
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
        let msg = formatPullResult(importResult.output, importResult.error);
        if (wantsDescribeWithPull(content) && !importResult.error) {
          msg += "\n\n" + formatRepoDescription();
        }
        savedContent += (savedContent ? "\n\n" : "") + msg;
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
      }
    } else if (isGreeting(content)) {
      const msg = "Hi — what would you like to work on?";
      savedContent = msg;
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
    } else if (isDescribeRepoIntent(content)) {
      const msg = formatRepoDescription();
      savedContent = msg;
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
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

        if (decision.name === "import_github_repo") {
          workingMessages.push({
            role: "assistant",
            content: JSON.stringify({ action: "tool", name: decision.name, arguments: args }),
          });
          workingMessages.push({
            role: "user",
            content:
              "Tool blocked: import_github_repo is only for explicit pull requests. Answer in text. Do not pull.",
          });
          continue;
        }

        if (decision.name === "write_file" && !String(args.content ?? "").trim()) {
          workingMessages.push({
            role: "assistant",
            content: JSON.stringify({ action: "tool", name: decision.name, arguments: args }),
          });
          workingMessages.push({
            role: "user",
            content: "Tool error: write_file requires non-empty content.",
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
        const fallback = isExplicitPullIntent(content)
          ? "Pull did not complete. Say: pull"
          : "What would you like to do next?";
        savedContent = fallback;
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ content: fallback })}\n\n`);
        }
      }
    } else {
      const msg = "Forge needs the local AI path enabled. Try again in a moment.";
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
