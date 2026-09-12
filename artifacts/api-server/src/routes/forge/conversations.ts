import { Router, type IRouter } from "express";
import { db, conversations, messages } from "@workspace/db";
import { ai } from "@workspace/integrations-gemini-ai";
import {
  localAgentTurn,
  buildLocalToolResultMessage,
  toLocalToolDefinitions,
  type LocalChatMessage,
} from "@workspace/integrations-local-ai";
import { eq, desc, isNull } from "drizzle-orm";
import { forgeToolDeclarations, executeForgeTool, truncateSummary } from "./forge-tools";
import { FunctionCallingConfigMode, type FunctionCall } from "@google/genai";
import { friendlyGeminiErrorMessage } from "../../lib/gemini-errors";
import { getAiProvider } from "../../lib/ai-provider";

const router: IRouter = Router();

router.get("/", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const result = await db
    .select()
    .from(conversations)
    .where(userId ? eq(conversations.userId, userId) : isNull(conversations.userId))
    .orderBy(desc(conversations.createdAt));
  res.json(
    result.filter((c) => c.source === "forge").map((c) => ({
      id: c.id, title: c.title, createdAt: c.createdAt,
    }))
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
  const forgeCount = existing.filter((c) => c.source === "forge").length;
  if (forgeCount >= 10) {
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
  if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json({
    id: conv.id, title: conv.title, createdAt: conv.createdAt,
    messages: msgs.map((m) => ({ id: m.id, conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt })),
  });
});

router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { title } = req.body as { title: string };
  if (!title?.trim()) { res.status(400).json({ error: "Title required" }); return; }
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  const [updated] = await db.update(conversations).set({ title: title.trim() }).where(eq(conversations.id, id)).returning();
  res.json({ id: updated.id, title: updated.title, createdAt: updated.createdAt });
});

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  await db.delete(conversations).where(eq(conversations.id, id));
  res.status(204).end();
});

router.get("/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json(msgs.map((m) => ({ id: m.id, conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt })));
});

router.post("/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const { content, guestHistory: rawGuestHistory } = req.body as { content: string; guestHistory?: Array<{role: string; content: string}> };
  const guestHistory: Array<{role: string; content: string}> = rawGuestHistory ?? [];
  const userId = req.session?.userId ?? null;
  const isPersisted = !!userId && id > 0;

  if (isPersisted) {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  }

  const history: Array<{role: string; content: string}> = isPersisted
    ? (await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt)).map((m) => ({ role: m.role, content: m.content }))
    : guestHistory;

  if (isPersisted) {
    await db.insert(messages).values({ conversationId: id, role: "user", content });
  }

  const nowUtc = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const timeUtc = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: true });

  const systemPrompt = `Today is ${nowUtc}, ${timeUtc} UTC.\n\nYou are Forge, an AI that builds small apps for people, directly in this conversation —\nusing tools as you go.\n\nAvailable tools: write/delete frontend files (HTML/CSS/JS), structured tables, write_backend_handler, add_accounts, run_preview, and import_github_repo.\n\nimport_github_repo pulls the user's connected GitHub repo (optional path subdirectory) into this Forge app so they can press Run to preview. Copies html/css/js/json/md/svg/txt. Prefer paths with index.html.\n\nEvery tool call needs a "summary" argument (past tense, 8 words max).\n\nOnce index.html exists, call run_preview, then tell the user to hit Run.\nUse relative api/ paths for backend handlers inside the preview.\n\n${isPersisted ? "" : "IMPORTANT: this person is not logged in — tools won't be saved. Ask them to log in first."}`;

  if (getAiProvider() === "local") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let savedContent = "";
    let lastToolError: string | null = null;
    let endedNaturally = false;
    try {
      const workingMessages: LocalChatMessage[] = [
        {
          role: "system",
          content: `${systemPrompt}\n\nYou are running in a free local model. Use the JSON tool protocol exactly.`,
        },
        ...history.slice(-5).map((m): LocalChatMessage => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content.slice(0, 1800),
        })),
        { role: "user", content: content.slice(0, 3000) },
      ];
      const localTools = toLocalToolDefinitions(forgeToolDeclarations);

      for (let turn = 0; turn < 16; turn++) {
        const decision = await localAgentTurn(workingMessages, localTools, { maxNewTokens: 1400 });
        if (decision.kind === "final") {
          endedNaturally = true;
          savedContent += decision.content;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: decision.content })}\n\n`);
          break;
        }

        const toolId = `${Date.now()}-${turn}`;
        const summary = truncateSummary(decision.arguments.summary, decision.name);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name: decision.name, summary } })}\n\n`);
        }

        const result = isPersisted
          ? await executeForgeTool(id, decision.name, decision.arguments, userId)
          : { error: "This person isn't logged in yet, so building can't be saved. Ask them to log in first." };
        if (result.error) {
          lastToolError = result.error;
          req.log.error({ tool: decision.name, args: decision.arguments, error: result.error }, "[Forge] Local tool execution failed");
        }
        savedContent += result.error ? `\n\n✗ ${summary} — ${result.error}` : `\n\n✓ ${summary}`;
        if (!res.writableEnded) {
          const event = result.error
            ? { toolError: { id: toolId, summary, error: result.error } }
            : { toolDone: { id: toolId, summary } };
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        workingMessages.push({
          role: "assistant",
          content: JSON.stringify({ action: "tool", name: decision.name, arguments: decision.arguments }),
        });
        workingMessages.push({ role: "user", content: buildLocalToolResultMessage(decision.name, result) });
      }

      if (!endedNaturally && isPersisted) {
        const previewSummary = "Verified app is ready to run";
        const previewToolId = `${Date.now()}-final-preview`;
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ toolStart: { id: previewToolId, name: "run_preview", summary: previewSummary } })}\n\n`);
        }
        const previewResult = await executeForgeTool(id, "run_preview", { summary: previewSummary }, userId);
        if (!previewResult.error) {
          endedNaturally = true;
          savedContent += `\n\n✓ ${previewSummary}.`;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolDone: { id: previewToolId, summary: previewSummary } })}\n\n`);
        } else {
          lastToolError = previewResult.error;
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ toolError: { id: previewToolId, summary: previewSummary, error: previewResult.error } })}\n\n`);
          }
        }
      }

      if (!endedNaturally) {
        const fallback = lastToolError
          ? `\n\nI couldn't complete the app. Last error: \`${lastToolError}\``
          : "\n\nThe local model reached its safety limit. Retry to continue.";
        savedContent += fallback;
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: fallback })}\n\n`);
      }

      if (isPersisted && savedContent) {
        await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });
      }
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
      }
    } catch (err) {
      const friendlyMessage = friendlyGeminiErrorMessage(err, "Local model failed to build the app");
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: friendlyMessage })}\n\n`);
        res.end();
      }
    }
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ error: "Cloud AI is not configured. Set AXIS_AI_PROVIDER=local or configure Gemini." })}\n\n`);
    res.end();
  }
});

export default router;
